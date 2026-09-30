import * as fs from "node:fs"
import fsPromises from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { ModelInfo } from "@shared/api"
import { DietCodeFileStorage } from "@shared/storage/DietCodeFileStorage"
import { createStorageContext } from "@shared/storage/storage-context"
import { expect } from "chai"
import { afterEach, beforeEach, describe, it } from "mocha"
import { HostProvider } from "@/hosts/host-provider"
import { readTaskSettingsFromStorage, writeTaskSettingsToStorage } from "../disk"
import { StateManager } from "../StateManager"
import { writeCoalescer } from "../WriteCoalescer"

describe("Storage & Memory Optimizations", () => {
	let tempDir: string

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-opt-test-"))
	})

	afterEach(() => {
		writeCoalescer.dispose()
		HostProvider.reset()
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	describe("DietCodeFileStorage Event & Write Deduplication", () => {
		it("should fire change event exactly once per set call and suppress no-op writes", async () => {
			const filePath = path.join(tempDir, "test_storage.json")
			const storage = new DietCodeFileStorage<string>(filePath)

			let changeEventCount = 0
			storage.onDidChange(() => {
				changeEventCount++
			})

			// First set should update data and fire event once
			storage.set("key1", "val1")
			expect(changeEventCount).to.equal(1)
			expect(storage.get("key1")).to.equal("val1")

			// Setting the exact same value should suppress write and change event
			storage.set("key1", "val1")
			expect(changeEventCount).to.equal(1) // Still 1!

			// Updating value should fire event once
			storage.set("key1", "val2")
			expect(changeEventCount).to.equal(2)
			expect(storage.get("key1")).to.equal("val2")
		})

		it("should suppress structurally identical object updates", async () => {
			const filePath = path.join(tempDir, "object_storage.json")
			const storage = new DietCodeFileStorage<Record<string, boolean>>(filePath)
			let changeEventCount = 0
			storage.onDidChange(() => {
				changeEventCount++
			})

			storage.set("toggles", { enabled: true })
			await storage.flush()
			storage.set("toggles", { enabled: true })

			expect(changeEventCount).to.equal(1)
			expect(storage.get("toggles")).to.deep.equal({ enabled: true })
		})

		it("should surface an explicit flush failure and retry the latest snapshot after recovery", async () => {
			const blockedParent = path.join(tempDir, "blocked-parent")
			fs.writeFileSync(blockedParent, "not a directory")
			const filePath = path.join(blockedParent, "state.json")
			const storage = new DietCodeFileStorage<string>(filePath)

			storage.set("key", "value")
			let flushError: unknown
			try {
				await storage.flush()
			} catch (error) {
				flushError = error
			}

			expect(flushError).to.be.instanceOf(Error)

			fs.rmSync(blockedParent, { force: true })
			await storage.flush()
			expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).to.deep.equal({ key: "value" })
		})
	})

	describe("WriteCoalescer Upfront Hash Pre-Filtering & Closure Binding", () => {
		it("should skip scheduling when content hash is unchanged and nothing is pending", async () => {
			const targetFile = path.join(tempDir, "coalescer_target.json")
			let diskWriteCount = 0

			const writeFn = async (data: string) => {
				diskWriteCount++
				fs.writeFileSync(targetFile, data)
			}

			// First write should schedule and execute
			writeCoalescer.coalesceWriteWithPayload(targetFile, () => '{"hello":"world"}', writeFn, 50)
			expect(writeCoalescer.hasPending(targetFile)).to.equal(true)

			await writeCoalescer.flush(targetFile)
			expect(diskWriteCount).to.equal(1)
			expect(writeCoalescer.hasPending(targetFile)).to.equal(false)

			// Calling coalesceWriteWithPayload with identical payload should immediately return without queuing
			writeCoalescer.coalesceWriteWithPayload(targetFile, () => '{"hello":"world"}', writeFn, 50)
			expect(writeCoalescer.hasPending(targetFile)).to.equal(false)
		})

		it("should serialize a newer payload behind an in-flight write", async () => {
			const targetFile = path.join(tempDir, "coalescer_ordered_target.json")
			const writeOrder: string[] = []
			let releaseFirstWrite!: () => void
			let resolveFirstWriteStarted!: () => void
			const firstWriteStarted = new Promise<void>((resolve) => {
				resolveFirstWriteStarted = resolve
			})
			const firstWriteGate = new Promise<void>((resolve) => {
				releaseFirstWrite = resolve
			})
			const writeFn = async (data: string) => {
				writeOrder.push(data)
				if (data === "first") {
					resolveFirstWriteStarted()
					await firstWriteGate
				}
				fs.writeFileSync(targetFile, data)
			}

			try {
				writeCoalescer.coalesceWriteWithPayload(targetFile, () => "first", writeFn, 1000)
				const firstFlush = writeCoalescer.flush(targetFile)
				await firstWriteStarted

				writeCoalescer.coalesceWriteWithPayload(targetFile, () => "second", writeFn, 1000)
				const secondFlush = writeCoalescer.flush(targetFile)
				releaseFirstWrite()
				await Promise.all([firstFlush, secondFlush])

				expect(writeOrder).to.deep.equal(["first", "second"])
				expect(fs.readFileSync(targetFile, "utf8")).to.equal("second")
			} finally {
				releaseFirstWrite()
				await writeCoalescer.flush(targetFile)
			}
		})

		it("should surface explicit flush failures and recover the serialized write queue", async () => {
			const targetFile = path.join(tempDir, "coalescer_recovery_target.json")
			const failure = new Error("disk unavailable")

			writeCoalescer.coalesceWriteWithPayload(
				targetFile,
				() => "broken",
				async () => {
					throw failure
				},
				1000,
			)

			let flushError: unknown
			try {
				await writeCoalescer.flush(targetFile, { throwOnError: true })
			} catch (error) {
				flushError = error
			}

			expect(flushError).to.equal(failure)

			writeCoalescer.coalesceWriteWithPayload(
				targetFile,
				() => "recovered",
				async (data) => {
					fs.writeFileSync(targetFile, data)
				},
				1000,
			)
			await writeCoalescer.flush(targetFile, { throwOnError: true })
			expect(fs.readFileSync(targetFile, "utf8")).to.equal("recovered")
		})

		it("should wait for sibling writes before surfacing a flushAll failure", async () => {
			const failedFile = path.join(tempDir, "coalescer_flush_all_failed.json")
			const slowFile = path.join(tempDir, "coalescer_flush_all_slow.json")
			const failure = new Error("first file unavailable")
			let releaseSlowWrite!: () => void
			let resolveSlowStarted!: () => void
			let resolveSlowFinished!: () => void
			let slowWriteStarted = false
			const slowStarted = new Promise<void>((resolve) => {
				resolveSlowStarted = resolve
			})
			const slowFinished = new Promise<void>((resolve) => {
				resolveSlowFinished = resolve
			})
			const slowGate = new Promise<void>((resolve) => {
				releaseSlowWrite = resolve
			})

			writeCoalescer.coalesceWriteWithPayload(
				failedFile,
				() => "failed",
				async () => {
					throw failure
				},
				1000,
			)
			writeCoalescer.coalesceWriteWithPayload(
				slowFile,
				() => "slow",
				async (data) => {
					slowWriteStarted = true
					resolveSlowStarted()
					await slowGate
					fs.writeFileSync(slowFile, data)
					resolveSlowFinished()
				},
				1000,
			)

			const flushPromise = writeCoalescer.flushAll({ throwOnError: true })
			await slowStarted
			let flushSettled = false
			void flushPromise.then(
				() => {
					flushSettled = true
				},
				() => {
					flushSettled = true
				},
			)
			await Promise.resolve()
			expect(flushSettled).to.equal(false)

			releaseSlowWrite()
			await slowFinished
			let flushError: unknown
			try {
				await flushPromise
			} catch (error) {
				flushError = error
			}
			expect(flushError).to.equal(failure)
			expect(slowWriteStarted).to.equal(true)
			expect(fs.readFileSync(slowFile, "utf8")).to.equal("slow")
		})

		it("should drain writes queued while another file is flushing", async () => {
			const firstFile = path.join(tempDir, "coalescer_flush_all_first.json")
			const lateFile = path.join(tempDir, "coalescer_flush_all_late.json")
			let lateWriteQueued = false

			writeCoalescer.coalesceWriteWithPayload(
				firstFile,
				() => "first",
				async (data) => {
					fs.writeFileSync(firstFile, data)
					if (!lateWriteQueued) {
						lateWriteQueued = true
						writeCoalescer.coalesceWriteWithPayload(
							lateFile,
							() => "late",
							async (lateData) => fs.writeFileSync(lateFile, lateData),
							1000,
						)
					}
				},
				1000,
			)

			await writeCoalescer.flushAll({ throwOnError: true })
			expect(fs.readFileSync(firstFile, "utf8")).to.equal("first")
			expect(fs.readFileSync(lateFile, "utf8")).to.equal("late")
		})

		it("should bound flushAll when a producer never reaches quiescence", async () => {
			const targetFile = path.join(tempDir, "coalescer_non_quiescent.json")
			let writeCount = 0
			const writeFn = async (data: string) => {
				writeCount++
				fs.writeFileSync(targetFile, data)
				writeCoalescer.coalesceWriteWithPayload(targetFile, () => String(writeCount), writeFn, 1000)
			}

			writeCoalescer.coalesceWriteWithPayload(targetFile, () => "0", writeFn, 1000)
			try {
				let flushError: unknown
				try {
					await writeCoalescer.flushAll({ throwOnError: true, maxDrainPasses: 2 })
				} catch (error) {
					flushError = error
				}
				expect(flushError).to.be.instanceOf(Error)
				expect((flushError as Error).message).to.match(/did not quiesce/i)
				expect(writeCount).to.equal(2)
			} finally {
				writeCoalescer.dispose()
			}
		})
	})

	describe("StateManager Model Cache Purging", () => {
		it("should purge expired model caches correctly", async () => {
			const storageContext = createStorageContext({ dietcodeDir: tempDir, workspacePath: tempDir })
			const manager = Reflect.construct(StateManager, [storageContext]) as StateManager

			const sampleModelInfo: Record<string, ModelInfo> = {
				"model-a": { name: "Model A" } as ModelInfo,
			}

			manager.setModelsCache("dietcode", sampleModelInfo)
			expect(manager.getModelsCache("dietcode")).to.not.equal(null)

			// Fast-forward timestamp to simulate expiration (> 1 hour)
			const privateState = manager as unknown as { modelInfoCache: Record<string, { timestamp: number } | null> }
			const cacheObj = privateState.modelInfoCache.dietcodeModels
			if (cacheObj) {
				cacheObj.timestamp = Date.now() - (60 * 60 * 1000 + 5000)
			}

			manager.purgeExpiredCaches()
			expect(manager.getModelsCache("dietcode")).to.equal(null)
		})
	})

	describe("StateManager Task Settings Isolation", () => {
		function createInitializedManager(): StateManager {
			HostProvider.initialize(
				(() => undefined) as unknown as Parameters<typeof HostProvider.initialize>[0],
				(() => undefined) as unknown as Parameters<typeof HostProvider.initialize>[1],
				(() => undefined) as unknown as Parameters<typeof HostProvider.initialize>[2],
				(() => undefined) as unknown as Parameters<typeof HostProvider.initialize>[3],
				{ workspaceClient: {}, envClient: {}, windowClient: {}, diffClient: {} } as Parameters<
					typeof HostProvider.initialize
				>[4],
				() => {},
				async () => "",
				async () => "",
				path.join(tempDir, "extension"),
				path.join(tempDir, "global"),
			)
			const manager = Reflect.construct(StateManager, [
				createStorageContext({ dietcodeDir: tempDir, workspacePath: tempDir }),
			]) as StateManager
			;(manager as unknown as { isInitialized: boolean }).isInitialized = true
			return manager
		}

		it("should retain an in-place object mutation that arrives during persistence", async () => {
			const manager = createInitializedManager()
			const toggles = { "rules/race.md": true }
			manager.setWorkspaceState("localDietCodeRulesToggles", toggles)

			let releaseFirstWrite!: () => void
			let resolveFirstWriteStarted!: () => void
			const firstWriteStarted = new Promise<void>((resolve) => {
				resolveFirstWriteStarted = resolve
			})
			const firstWriteGate = new Promise<void>((resolve) => {
				releaseFirstWrite = resolve
			})
			const mutableFsPromises = fsPromises as unknown as {
				writeFile: (...args: Parameters<typeof fsPromises.writeFile>) => ReturnType<typeof fsPromises.writeFile>
			}
			const originalWriteFile = mutableFsPromises.writeFile
			mutableFsPromises.writeFile = async (...args: Parameters<typeof fsPromises.writeFile>) => {
				const targetPath = String(args[0])
				if (targetPath.includes("workspaceState.json.")) {
					resolveFirstWriteStarted()
					await firstWriteGate
				}
				return originalWriteFile(...args)
			}

			try {
				const firstFlush = manager.flushPendingState()
				await firstWriteStarted
				toggles["rules/race.md"] = false
				releaseFirstWrite()
				await firstFlush
				await manager.flushPendingState()

				const storageContext = createStorageContext({ dietcodeDir: tempDir, workspacePath: tempDir })
				const workspaceStatePath = path.join(storageContext.workspaceStoragePath, "workspaceState.json")
				expect(JSON.parse(fs.readFileSync(workspaceStatePath, "utf8")).localDietCodeRulesToggles).to.deep.equal({
					"rules/race.md": false,
				})
			} finally {
				releaseFirstWrite()
				mutableFsPromises.writeFile = originalWriteFile
			}
		})

		it("should detect an in-place workspace mutation after a prior flush", async () => {
			const manager = createInitializedManager()
			const toggles = { "rules/after-flush.md": true }

			manager.setWorkspaceState("localDietCodeRulesToggles", toggles)
			await manager.flushPendingState()

			// Several familiar toggle handlers mutate the object returned from the
			// cache and pass that same reference back to StateManager.
			toggles["rules/after-flush.md"] = false
			manager.setWorkspaceState("localDietCodeRulesToggles", toggles)
			await manager.flushPendingState()

			const storageContext = createStorageContext({ dietcodeDir: tempDir, workspacePath: tempDir })
			const workspaceStatePath = path.join(storageContext.workspaceStoragePath, "workspaceState.json")
			expect(JSON.parse(fs.readFileSync(workspaceStatePath, "utf8")).localDietCodeRulesToggles).to.deep.equal({
				"rules/after-flush.md": false,
			})
		})

		it("should replace the active task cache instead of carrying overrides into a new task", async () => {
			const manager = createInitializedManager()

			manager.setTaskSettings("previous-task", "joyZoningSteeringEnabled", true)
			await writeTaskSettingsToStorage("next-task", { mode: "plan" })

			await manager.loadTaskSettings("next-task")

			expect(manager.getTaskSettingsKey("joyZoningSteeringEnabled")).to.equal(undefined)
			expect(manager.getTaskSettingsKey("mode")).to.equal("plan")
			expect(await readTaskSettingsFromStorage("previous-task")).to.deep.equal({
				joyZoningSteeringEnabled: true,
			})
		})

		it("should persist each task's latest snapshot when debounced updates overlap", async () => {
			const manager = createInitializedManager()

			manager.setTaskSettings("task-a", "joyZoningSteeringEnabled", true)
			manager.setTaskSettings("task-b", "joyZoningSteeringEnabled", false)
			await manager.flushPendingState()

			expect(await readTaskSettingsFromStorage("task-a")).to.deep.equal({
				joyZoningSteeringEnabled: true,
			})
			expect(await readTaskSettingsFromStorage("task-b")).to.deep.equal({
				joyZoningSteeringEnabled: false,
			})
		})

		it("should drain file-backed global writes before an explicit flush returns", async () => {
			const manager = createInitializedManager()
			manager.setGlobalState("joyZoningSteeringEnabled", false)

			await manager.flushPendingState()

			const globalStatePath = path.join(tempDir, "data", "globalState.json")
			expect(JSON.parse(fs.readFileSync(globalStatePath, "utf8")).joyZoningSteeringEnabled).to.equal(false)
		})

		it("should retry an explicit persistence failure after the disk recovers", async () => {
			const manager = createInitializedManager()
			manager.setGlobalState("joyZoningSteeringEnabled", false)

			const mutableFsPromises = fsPromises as unknown as {
				writeFile: (...args: Parameters<typeof fsPromises.writeFile>) => ReturnType<typeof fsPromises.writeFile>
				rename: typeof fsPromises.rename
			}
			const originalWriteFile = mutableFsPromises.writeFile
			const originalRename = mutableFsPromises.rename
			let finishRecovery!: () => void
			const recovered = new Promise<void>((resolve) => {
				finishRecovery = resolve
			})
			mutableFsPromises.rename = async (...args) => {
				await originalRename(...args)
				if (String(args[1]) === path.join(tempDir, "data", "globalState.json")) finishRecovery()
			}
			let shouldFail = true
			mutableFsPromises.writeFile = async (...args: Parameters<typeof fsPromises.writeFile>) => {
				const targetPath = String(args[0])
				if (shouldFail && targetPath.includes("globalState.json.")) {
					throw new Error("transient persistence failure")
				}
				return originalWriteFile(...args)
			}

			try {
				let flushError: unknown
				try {
					await manager.flushPendingState()
				} catch (error) {
					flushError = error
				}
				expect(flushError).to.be.instanceOf(Error)

				shouldFail = false
				// Observe the automatic retry's actual atomic rename. A wall-clock
				// delay can expire before disk I/O completes on a busy test machine.
				await recovered
				await manager.flushPendingState()

				const globalStatePath = path.join(tempDir, "data", "globalState.json")
				expect(JSON.parse(fs.readFileSync(globalStatePath, "utf8")).joyZoningSteeringEnabled).to.equal(false)
			} finally {
				mutableFsPromises.writeFile = originalWriteFile
				mutableFsPromises.rename = originalRename
			}
		})

		it("should retain pending state when reInitialize cannot flush", async () => {
			const manager = createInitializedManager()
			manager.setGlobalState("joyZoningSteeringEnabled", false)

			const mutableFsPromises = fsPromises as unknown as {
				writeFile: (...args: Parameters<typeof fsPromises.writeFile>) => ReturnType<typeof fsPromises.writeFile>
			}
			const originalWriteFile = mutableFsPromises.writeFile
			mutableFsPromises.writeFile = async (...args: Parameters<typeof fsPromises.writeFile>) => {
				if (String(args[0]).includes("globalState.json.")) {
					throw new Error("reinitialize persistence failure")
				}
				return originalWriteFile(...args)
			}

			try {
				let reinitializeError: unknown
				try {
					await manager.reInitialize()
				} catch (error) {
					reinitializeError = error
				}
				expect(reinitializeError).to.be.instanceOf(Error)
				expect(
					(manager as unknown as { pendingGlobalState: Set<string> }).pendingGlobalState.has(
						"joyZoningSteeringEnabled",
					),
				).to.equal(true)
			} finally {
				mutableFsPromises.writeFile = originalWriteFile
			}

			await manager.flushPendingState()
			const globalStatePath = path.join(tempDir, "data", "globalState.json")
			expect(JSON.parse(fs.readFileSync(globalStatePath, "utf8")).joyZoningSteeringEnabled).to.equal(false)
		})

		it("should bound a state producer that never reaches persistence quiescence", async () => {
			const manager = createInitializedManager()
			manager.setGlobalState("joyZoningSteeringEnabled", false)

			const mutableFsPromises = fsPromises as unknown as {
				writeFile: (...args: Parameters<typeof fsPromises.writeFile>) => ReturnType<typeof fsPromises.writeFile>
			}
			const originalWriteFile = mutableFsPromises.writeFile
			let writeCount = 0
			mutableFsPromises.writeFile = async (...args: Parameters<typeof fsPromises.writeFile>) => {
				if (String(args[0]).includes("globalState.json.")) {
					writeCount++
					manager.setGlobalState("joyZoningSteeringEnabled", writeCount % 2 !== 0)
				}
				return originalWriteFile(...args)
			}

			try {
				let flushError: unknown
				try {
					await manager.flushPendingState()
				} catch (error) {
					flushError = error
				}
				expect(flushError, `writeCount=${writeCount}`).to.be.instanceOf(Error)
				expect((flushError as Error).message).to.match(/did not quiesce/i)
				expect(writeCount).to.equal(100)
			} finally {
				mutableFsPromises.writeFile = originalWriteFile
			}

			// The failed barrier leaves the latest snapshot queued and recoverable.
			await manager.flushPendingState()
		})

		it("should drain and invalidate workspace storage before a full reset", async () => {
			const storageContext = createStorageContext({ dietcodeDir: tempDir, workspacePath: tempDir })
			const manager = Reflect.construct(StateManager, [storageContext]) as StateManager
			;(manager as unknown as { isInitialized: boolean }).isInitialized = true

			manager.setWorkspaceState("localDietCodeRulesToggles", { "rules/example.md": true })
			await manager.resetAllWorkspaces()

			const workspaceStatePath = path.join(storageContext.workspaceStoragePath, "workspaceState.json")
			expect(storageContext.workspaceState.keys()).to.deep.equal([])
			expect(fs.existsSync(workspaceStatePath)).to.equal(false)

			// Reusing the old value after reset must write a fresh file instead of
			// being skipped by the stale content hash.
			manager.setWorkspaceState("localDietCodeRulesToggles", { "rules/example.md": true })
			await manager.flushPendingState()
			expect(JSON.parse(fs.readFileSync(workspaceStatePath, "utf8"))).to.deep.equal({
				localDietCodeRulesToggles: { "rules/example.md": true },
			})
		})

		it("should cancel a delayed workspace write so reset cannot recreate deleted state", async () => {
			const storageContext = createStorageContext({ dietcodeDir: tempDir, workspacePath: tempDir })
			const manager = Reflect.construct(StateManager, [storageContext]) as StateManager
			;(manager as unknown as { isInitialized: boolean }).isInitialized = true

			manager.setWorkspaceState("localDietCodeRulesToggles", { "rules/delayed.md": true })
			await manager.resetAllWorkspaces()

			// The debounce window is 500ms. Waiting beyond it proves that the reset
			// canceled the manager timer rather than only deleting the current file.
			await new Promise((resolve) => setTimeout(resolve, 550))
			const workspaceStatePath = path.join(storageContext.workspaceStoragePath, "workspaceState.json")
			expect(fs.existsSync(workspaceStatePath)).to.equal(false)
		})

		it("should re-arm unrelated persistence after a workspace reset", async () => {
			const storageContext = createStorageContext({ dietcodeDir: tempDir, workspacePath: tempDir })
			const manager = Reflect.construct(StateManager, [storageContext]) as StateManager
			;(manager as unknown as { isInitialized: boolean }).isInitialized = true

			manager.setGlobalState("joyZoningSteeringEnabled", false)
			manager.setWorkspaceState("localDietCodeRulesToggles", { "rules/discarded.md": true })
			await manager.resetAllWorkspaces()
			await new Promise((resolve) => setTimeout(resolve, 550))

			const globalStatePath = path.join(storageContext.dataDir, "globalState.json")
			expect(JSON.parse(fs.readFileSync(globalStatePath, "utf8")).joyZoningSteeringEnabled).to.equal(false)
			const workspaceStatePath = path.join(storageContext.workspaceStoragePath, "workspaceState.json")
			expect(fs.existsSync(workspaceStatePath)).to.equal(false)
		})

		it("should serialize overlapping writes for one task without dropping fields", async () => {
			createInitializedManager()

			await Promise.all([
				writeTaskSettingsToStorage("same-task", { joyZoningSteeringEnabled: true }),
				writeTaskSettingsToStorage("same-task", { mode: "plan" }),
			])

			expect(await readTaskSettingsFromStorage("same-task")).to.deep.equal({
				joyZoningSteeringEnabled: true,
				mode: "plan",
			})
		})

		it("should retain a task update that arrives while persistence is in flight", async () => {
			const manager = createInitializedManager()
			manager.setTaskSettings("racing-task", "joyZoningSteeringEnabled", true)

			let releaseFirstWrite!: () => void
			let resolveFirstWriteStarted!: () => void
			const firstWriteStarted = new Promise<void>((resolve) => {
				resolveFirstWriteStarted = resolve
			})
			const firstWriteGate = new Promise<void>((resolve) => {
				releaseFirstWrite = resolve
			})
			const mutableFsPromises = fsPromises as unknown as {
				writeFile: (...args: Parameters<typeof fsPromises.writeFile>) => ReturnType<typeof fsPromises.writeFile>
			}
			const originalWriteFile = mutableFsPromises.writeFile
			mutableFsPromises.writeFile = async (...args: Parameters<typeof fsPromises.writeFile>) => {
				const targetPath = String(args[0])
				if (targetPath.includes("settings.json.")) {
					resolveFirstWriteStarted()
					await firstWriteGate
				}
				return originalWriteFile(...args)
			}

			try {
				const firstFlush = manager.flushPendingState()
				await firstWriteStarted
				manager.setTaskSettings("racing-task", "joyZoningSteeringEnabled", false)
				releaseFirstWrite()
				await firstFlush

				await manager.flushPendingState()
				expect(await readTaskSettingsFromStorage("racing-task")).to.deep.equal({
					joyZoningSteeringEnabled: false,
				})
			} finally {
				mutableFsPromises.writeFile = originalWriteFile
			}
		})
	})

	describe("Disk Temp File Clean Sweeping", () => {
		it("should remove stale .tmp files older than maxAgeMs", async () => {
			const { cleanStaleTempFiles } = await import("../disk")
			const staleTmp = path.join(tempDir, "stale_data.12345.tmp")
			const freshTmp = path.join(tempDir, "fresh_data.67890.tmp")

			fs.writeFileSync(staleTmp, "stale data")
			fs.writeFileSync(freshTmp, "fresh data")

			// Backdate mtime of staleTmp to 15 minutes ago
			const oldTime = new Date(Date.now() - 15 * 60 * 1000)
			fs.utimesSync(staleTmp, oldTime, oldTime)

			const freedBytes = await cleanStaleTempFiles(tempDir, 10 * 60 * 1000)
			expect(freedBytes).to.be.greaterThan(0)
			expect(fs.existsSync(staleTmp)).to.equal(false)
			expect(fs.existsSync(freshTmp)).to.equal(true)
		})
	})
})
