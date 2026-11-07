import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "mocha"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import "should"
import fs from "fs"
import * as sinon from "sinon"
import * as vscode from "vscode"
import { VscodeTerminalProcess } from "./VscodeTerminalProcess"
import { TerminalRegistry } from "./VscodeTerminalRegistry"

interface VscodeTerminalProcessTestAccess {
	buffer: string
	emitIfEol(chunk: string): void
	emitRemainingBufferIfListening(): void
	isListening: boolean
}

declare module "vscode" {
	// https://github.com/microsoft/vscode/blob/f0417069c62e20f3667506f4b7e53ca0004b4e3e/src/vscode-dts/vscode.d.ts#L7442
	interface Terminal {
		shellIntegration?: {
			cwd?: vscode.Uri
			executeCommand?: (command: string) => {
				read: () => AsyncIterable<string>
			}
		}
	}
}

// Create a mock stream for simulating terminal output - this is only used for tests
// that need controlled output which can't be guaranteed with real terminals
function createMockStream(lines: string[] = ["test-command", "line1", "line2", "line3"]) {
	return {
		async *[Symbol.asyncIterator]() {
			for (const line of lines) {
				yield `${line}\n`
			}
		},
	}
}

describe("TerminalProcess (Integration Tests)", () => {
	let process: VscodeTerminalProcess
	let sandbox: sinon.SinonSandbox
	let createdTerminals: vscode.Terminal[] = []

	beforeEach(() => {
		sandbox = sinon.createSandbox({ useFakeTimers: true })
		setVscodeHostProviderMock()
		process = new VscodeTerminalProcess()
	})

	afterEach(() => {
		// Restore sandbox, which restores timers and all Sinon fakes
		sandbox.restore()
		// Remove any event listeners left on the TerminalProcess
		process.removeAllListeners()
		// Dispose all terminals created during the test
		createdTerminals.forEach((t) => {
			t.dispose()
		})
		createdTerminals = []
	})

	describe("Real terminal tests", () => {
		// This test works with or without shell integration
		it("should create and run a command in a real terminal", async () => {
			// Create a real VS Code terminal for testing
			const terminal = TerminalRegistry.createTerminal().terminal
			createdTerminals.push(terminal)

			// Spy on emit to verify behavior
			const emitSpy = sandbox.spy(process, "emit")

			// Run a simple command
			const runPromise = process.run(terminal, "echo test")

			// If terminal doesn't have shell integration, advance timer
			if (!terminal.shellIntegration) {
				await sandbox.clock.tickAsync(3000)
			}

			await runPromise

			// Verify that the continue event was emitted
			;(emitSpy as sinon.SinonSpy).calledWith("continue").should.be.true()
			;(emitSpy as sinon.SinonSpy).calledWith("completed").should.be.true()
		})

		it("should execute and capture events from a simple command", async () => {
			// Create a real VS Code terminal
			const terminal = TerminalRegistry.createTerminal().terminal
			createdTerminals.push(terminal)

			// Spy on emit to verify line events
			const emitSpy = sandbox.spy(process, "emit")

			// Run a command that produces predictable output
			const runPromise = process.run(terminal, "echo 'Line 1' && echo 'Line 2'")

			// If terminal doesn't have shell integration, advance timer
			if (!terminal.shellIntegration) {
				await sandbox.clock.tickAsync(3000)
			}

			await runPromise

			// Check that the events were emitted
			;(emitSpy as sinon.SinonSpy).calledWith("completed").should.be.true()
			;(emitSpy as sinon.SinonSpy).calledWith("continue").should.be.true()
		})

		it("should execute a command that lists files", async () => {
			// Create a real VS Code terminal
			const terminal = TerminalRegistry.createTerminal().terminal
			createdTerminals.push(terminal)

			// Spy on emit to verify behavior
			const emitSpy = sandbox.spy(process, "emit")

			// Run a command that lists files
			const runPromise = process.run(terminal, "ls -la")

			// If terminal doesn't have shell integration, advance timer
			if (!terminal.shellIntegration) {
				await sandbox.clock.tickAsync(3000)
			}

			await runPromise

			// Verify that the continue event was emitted
			;(emitSpy as sinon.SinonSpy).calledWith("continue").should.be.true()
			;(emitSpy as sinon.SinonSpy).calledWith("completed").should.be.true()
		})

		it("should handle a longer running command", async () => {
			// Create a real terminal
			const terminal = TerminalRegistry.createTerminal().terminal
			createdTerminals.push(terminal)

			// Spy on emit to verify behavior
			const emitSpy = sandbox.spy(process, "emit")

			// Un-fake timers temporarily for this test since we need real timing
			sandbox.clock.restore()

			// Run a command that sleeps for a short period
			await process.run(terminal, "sleep 0.5 && echo 'Done sleeping'")

			// Verify that the continue and completed events were emitted
			;(emitSpy as sinon.SinonSpy).calledWith("continue").should.be.true()
			;(emitSpy as sinon.SinonSpy).calledWith("completed").should.be.true()

			// Restore fake timers for other tests
			sandbox.useFakeTimers()
		})

		it("should execute a command with arguments", async () => {
			// Create a real VS Code terminal
			const terminal = TerminalRegistry.createTerminal().terminal
			createdTerminals.push(terminal)

			// Spy on emit to verify line events
			const emitSpy = sandbox.spy(process, "emit")

			// Run a command that produces predictable output
			const runPromise = process.run(terminal, "echo 'Line 1' 'Line 2'")

			// If terminal doesn't have shell integration, advance timer
			if (!terminal.shellIntegration) {
				await sandbox.clock.tickAsync(3000)
			}

			await runPromise

			// Check that the events were emitted
			;(emitSpy as sinon.SinonSpy).calledWith("completed").should.be.true()
			;(emitSpy as sinon.SinonSpy).calledWith("continue").should.be.true()
		})

		it("should execute a command with quotes", async () => {
			// Create a real VS Code terminal
			const terminal = TerminalRegistry.createTerminal().terminal
			createdTerminals.push(terminal)

			// Spy on emit to verify line events
			const emitSpy = sandbox.spy(process, "emit")

			// Run a command that produces predictable output
			const runPromise = process.run(terminal, "echo \"Line 1\" && echo 'Line 2'")

			// If terminal doesn't have shell integration, advance timer
			if (!terminal.shellIntegration) {
				await sandbox.clock.tickAsync(3000)
			}

			await runPromise

			// Check that the events were emitted
			;(emitSpy as sinon.SinonSpy).calledWith("completed").should.be.true()
			;(emitSpy as sinon.SinonSpy).calledWith("continue").should.be.true()
		})
	})

	// Test that specifically checks for no shell integration
	it("should handle terminals without shell integration", async () => {
		// Create a real terminal without explicitly providing shell integration
		const terminal = vscode.window.createTerminal({ name: "Test Terminal" })
		createdTerminals.push(terminal)

		// Stub the shellIntegration getter to return undefined for this test
		sandbox.stub(terminal, "shellIntegration").get(() => undefined)

		// Stub the sendText method to verify it's called
		const sendTextStub = sandbox.stub(terminal, "sendText")

		sandbox.stub(fs.promises, "writeFile").resolves()
		sandbox.stub(fs.promises, "stat").rejects(Object.assign(new Error("not found"), { code: "ENOENT" }))
		sandbox.stub(fs.promises, "readFile").resolves("0")
		sandbox.stub(fs.promises, "unlink").resolves()

		// Spy on the emit function to verify events
		const emitSpy = sandbox.spy(process, "emit")

		// Run the command - this returns a promise
		const runPromise = process.run(terminal, "test-command")

		// Advance the fake timer by 100ms to trigger the first poll tick
		await sandbox.clock.tickAsync(100)

		// Now wait for the promise to resolve
		await runPromise

		// Check that the correct methods were called and events emitted
		sinon.assert.calledOnce(sendTextStub)
		sinon.assert.match(sendTextStub.firstCall.args[0], /dc-term-command/)
		;(emitSpy as sinon.SinonSpy).calledWith("completed").should.be.true()
		;(emitSpy as sinon.SinonSpy).calledWith("continue").should.be.true()

		// This event should be emitted for terminals without shell integration
		;(emitSpy as sinon.SinonSpy).calledWith("no_shell_integration").should.be.true()
	})

	it("should support fish shell fallback wrapping", async () => {
		const terminal = vscode.window.createTerminal({ name: "Fish Terminal" })
		createdTerminals.push(terminal)
		sandbox.stub(terminal, "shellIntegration").get(() => undefined)
		sandbox.stub(terminal, "state").get(
			() =>
				({
					isInteractedWith: false,
					shell: "fish",
				}) as vscode.TerminalState,
		)
		const sendTextStub = sandbox.stub(terminal, "sendText")

		const writeFileStub = sandbox.stub(fs.promises, "writeFile").resolves()
		sandbox.stub(fs.promises, "stat").rejects(Object.assign(new Error("not found"), { code: "ENOENT" }))
		sandbox.stub(fs.promises, "readFile").resolves("0")
		sandbox.stub(fs.promises, "unlink").resolves()

		const runPromise = process.run(terminal, "test-fish-command")
		await sandbox.clock.tickAsync(100)
		await runPromise

		sinon.assert.calledOnce(sendTextStub)
		const calledArg = sendTextStub.firstCall.args[0]
		calledArg.should.containEql("command 'fish'")
		calledArg.should.containEql("dc-term-command")
		calledArg.should.containEql("printf '%s\\n'")
		assert.match(String(writeFileStub.firstCall.args[1]), /test-fish-command/)
	})

	// The following tests require shell integration and controlled terminal output
	describe("Shell integration tests", () => {
		it("routes multiline heredocs through supervised capture instead of interactive shell integration", async () => {
			const terminal = TerminalRegistry.createTerminal().terminal
			createdTerminals.push(terminal)
			const executeCommand = sandbox.stub().returns({ read: () => createMockStream(["unexpected"]) })
			sandbox.stub(terminal, "shellIntegration").get(() => ({ executeCommand }))
			const fallback = sandbox
				.stub(
					process as unknown as {
						runWithoutShellIntegration: (...args: unknown[]) => Promise<void>
					},
					"runWithoutShellIntegration",
				)
				.resolves()
			const command = "python3 <<'PY'\nprint('safe fallback')\nPY"

			await process.run(terminal, command)

			sinon.assert.notCalled(executeCommand)
			sinon.assert.calledWithExactly(fallback, terminal, command, undefined, true)
		})

		// We'll mock the terminal run process and TerminalProcess for these tests
		it("should emit completed and continue events when command finishes", async () => {
			// Create a terminal to ensure proper interface, but we'll use mocking under the hood
			const terminal = TerminalRegistry.createTerminal().terminal
			createdTerminals.push(terminal)

			// Create a mock implementation of executeCommand
			const mockExecuteCommand = sandbox.stub().returns({
				read: () => createMockStream(["echo test", "test output"]),
			})

			// Create a fake shell integration object
			const mockShellIntegration = {
				executeCommand: mockExecuteCommand,
			}

			// Stub terminal.shellIntegration to return our mock
			sandbox.stub(terminal, "shellIntegration").get(() => mockShellIntegration)

			// Spy on emit to verify behavior
			const emitSpy = sandbox.spy(process, "emit")

			// Run the command
			await process.run(terminal, "echo test")

			// Verify the executeCommand was called with the right command
			mockExecuteCommand.calledWith("echo test").should.be.true()

			// Check that the events were emitted
			;(emitSpy as sinon.SinonSpy).calledWith("completed").should.be.true()
			;(emitSpy as sinon.SinonSpy).calledWith("continue").should.be.true()
		})
	})

	// Tests with controlled output
	describe("Controlled output tests", () => {
		it("should emit line events for each line of output", async () => {
			// Create a terminal
			const terminal = TerminalRegistry.createTerminal().terminal
			createdTerminals.push(terminal)

			// Mock the shell integration with controlled output
			const mockExecuteCommand = sandbox.stub().returns({
				read: () => createMockStream(["test-command", "line1", "line2", "line3"]),
			})

			// Create a mock shell integration object and stub the getter
			sandbox.stub(terminal, "shellIntegration").get(() => ({
				executeCommand: mockExecuteCommand,
			}))

			const emitSpy = sandbox.spy(process, "emit")

			await process.run(terminal, "test-command")

			// Check that line events were emitted for each line
			;(emitSpy as sinon.SinonSpy).calledWith("line", "line1").should.be.true()
			;(emitSpy as sinon.SinonSpy).calledWith("line", "line2").should.be.true()
			;(emitSpy as sinon.SinonSpy).calledWith("line", "line3").should.be.true()
		})

		it("should properly handle process hot state (e.g. compiling)", async () => {
			// Create a terminal
			const terminal = TerminalRegistry.createTerminal().terminal
			createdTerminals.push(terminal)

			// Mock the shell integration
			const mockExecuteCommand = sandbox.stub().returns({
				read: () => createMockStream(["compiling..."]),
			})

			// Create a mock shell integration object and stub the getter
			sandbox.stub(terminal, "shellIntegration").get(() => ({
				executeCommand: mockExecuteCommand,
			}))

			// Spy on global setTimeout
			const setTimeoutSpy = sandbox.spy(global, "setTimeout")

			await process.run(terminal, "build command")

			// Move time forward enough to schedule
			sandbox.clock.tick(100)

			// Expect a 15-second (>= 10000ms) hot timeout, since it saw "compiling"
			const foundCompilingTimeout = setTimeoutSpy.args.filter((args) => args[1] && args[1] >= 10000)
			foundCompilingTimeout.length.should.be.greaterThan(0)
		})

		it("should handle standard commands with normal hot timeout", async () => {
			// Create a terminal
			const terminal = TerminalRegistry.createTerminal().terminal
			createdTerminals.push(terminal)

			// Mock the shell integration
			const mockExecuteCommand = sandbox.stub().returns({
				read: () => createMockStream(["some normal output"]),
			})

			// Create a mock shell integration object and stub the getter
			sandbox.stub(terminal, "shellIntegration").get(() => ({
				executeCommand: mockExecuteCommand,
			}))

			const setTimeoutSpy = sandbox.spy(global, "setTimeout")

			await process.run(terminal, "standard command")
			sandbox.clock.tick(100)

			// Expect a short hot timeout (<= 5000)
			const foundNormalTimeout = setTimeoutSpy.args.filter((args) => args[1] && args[1] <= 5000)
			foundNormalTimeout.length.should.be.greaterThan(0)

			// Also check that "completed" eventually emits
			const emitSpy = sandbox.spy(process, "emit")
			await process.run(terminal, "another command")
			;(emitSpy as sinon.SinonSpy).calledWith("completed").should.be.true()
		})

		it("should correctly filter command echoes based on current implementation", async () => {
			// Create a terminal
			const terminal = TerminalRegistry.createTerminal().terminal
			createdTerminals.push(terminal)

			// Mock the shell integration
			const mockExecuteCommand = sandbox.stub().returns({
				read: () =>
					createMockStream([
						"test-command", // This should be filtered (command contains this exactly)
						"test command", // This should NOT be filtered (doesn't match exactly)
						"other output",
					]),
			})

			// Create a mock shell integration object and stub the getter
			sandbox.stub(terminal, "shellIntegration").get(() => ({
				executeCommand: mockExecuteCommand,
			}))

			const emitSpy = sandbox.spy(process, "emit")

			await process.run(terminal, "test-command")

			// Check that "test-command" was filtered out but "test command" was not
			;(emitSpy as sinon.SinonSpy).calledWith("line", "test command").should.be.true()
			;(emitSpy as sinon.SinonSpy).calledWith("line", "other output").should.be.true()
			// This should never be called because it should be filtered
			;(emitSpy as sinon.SinonSpy).calledWith("line", "test-command").should.be.false()
		})

		it("should handle npm run commands", async () => {
			// Create a terminal
			const terminal = TerminalRegistry.createTerminal().terminal
			createdTerminals.push(terminal)

			// Mock the shell integration
			const mockExecuteCommand = sandbox.stub().returns({
				read: () => createMockStream(["npm run build", "> project@1.0.0 build", "> tsc", "files built successfully"]),
			})

			// Create a mock shell integration object and stub the getter
			sandbox.stub(terminal, "shellIntegration").get(() => ({
				executeCommand: mockExecuteCommand,
			}))

			const emitSpy = sandbox.spy(process, "emit")

			await process.run(terminal, "npm run build")

			// The "npm run build" line should be filtered, but the rest should be emitted
			;(emitSpy as sinon.SinonSpy).calledWith("line", "> project@1.0.0 build").should.be.true()
			;(emitSpy as sinon.SinonSpy).calledWith("line", "> tsc").should.be.true()
			;(emitSpy as sinon.SinonSpy).calledWith("line", "files built successfully").should.be.true()
		})

		it("should preserve Unicode, repeated leading characters, and literal control notation", async () => {
			const terminal = TerminalRegistry.createTerminal().terminal
			createdTerminals.push(terminal)
			sandbox.stub(terminal, "shellIntegration").get(() => ({
				executeCommand: () => ({
					read: () => createMockStream(["success", "🧪 ready", "^C is documentation"]),
				}),
			}))
			const emittedLines: string[] = []
			process.on("line", (line) => emittedLines.push(line))

			await process.run(terminal, "build-command")

			assert.deepEqual(emittedLines.filter(Boolean), ["success", "🧪 ready", "^C is documentation"])
			assert.equal(process.getCompletionDetails().signal, null)
		})

		it("should treat a silent command with shell markers as a successful capture", async () => {
			const terminal = TerminalRegistry.createTerminal().terminal
			createdTerminals.push(terminal)
			sandbox.stub(terminal, "shellIntegration").get(() => ({
				executeCommand: () => ({
					read: () => createMockStream(["\u001b]633;C\u0007\u001b]633;D;0\u0007"]),
				}),
			}))
			const emittedLines: string[] = []
			process.on("line", (line) => emittedLines.push(line))

			await process.run(terminal, "true")

			assert.equal(process.getCompletionDetails().exitCode, 0)
			assert.equal(
				emittedLines.some((line) => line.includes("current terminal contents")),
				false,
			)
		})
	})

	// The following tests are shared with the unit tests to ensure consistent behavior
	it("should emit line for remaining buffer when emitRemainingBufferIfListening is called", () => {
		// Access private properties via type assertion
		const processInternals = process as unknown as VscodeTerminalProcessTestAccess
		processInternals.buffer = "test buffer content"
		processInternals.isListening = true

		const emitSpy = sandbox.spy(process, "emit")
		processInternals.emitRemainingBufferIfListening()
		;(emitSpy as sinon.SinonSpy).calledWith("line", "test buffer content").should.be.true()
		processInternals.buffer.should.equal("")
	})

	it("should remove prompt characters from the last line of output", () => {
		process.removeLastLineArtifacts("line 1\nline 2 %").should.equal("line 1\nline 2")
		process.removeLastLineArtifacts("line 1\nline 2 $").should.equal("line 1\nline 2")
		process.removeLastLineArtifacts("line 1\nline 2 #").should.equal("line 1\nline 2")
		process.removeLastLineArtifacts("line 1\nline 2 >").should.equal("line 1\nline 2")
	})

	it("should process buffer and emit lines when newline characters are found", () => {
		const processInternals = process as unknown as VscodeTerminalProcessTestAccess
		const emitSpy = sandbox.spy(process, "emit")

		processInternals.emitIfEol("line 1\nline 2\nline 3")
		;(emitSpy as sinon.SinonSpy).calledWith("line", "line 1").should.be.true()
		;(emitSpy as sinon.SinonSpy).calledWith("line", "line 2").should.be.true()
		processInternals.buffer.should.equal("line 3")

		processInternals.emitIfEol(" continued\n")
		;(emitSpy as sinon.SinonSpy).calledWith("line", "line 3 continued").should.be.true()
		processInternals.buffer.should.equal("")
	})

	it("should cancel before dispatch without starting the command", async () => {
		const terminal = TerminalRegistry.createTerminal().terminal
		createdTerminals.push(terminal)
		const executeCommand = sandbox.stub().returns({
			read: () => createMockStream(["should-not-run"]),
		})
		sandbox.stub(terminal, "shellIntegration").get(() => ({ executeCommand }))
		const completedSpy = sandbox.spy()
		process.on("completed", completedSpy)

		const runPromise = process.run(terminal, "echo test")
		process.terminate()
		await runPromise

		sinon.assert.notCalled(executeCommand)
		sinon.assert.calledOnce(completedSpy)
		assert.deepEqual(process.getCompletionDetails(), {
			exitCode: null,
			signal: "SIGINT",
		})
	})

	it("should send SIGINT after command execution has started", async () => {
		const terminal = TerminalRegistry.createTerminal().terminal
		createdTerminals.push(terminal)
		let resolveRead!: (value: IteratorResult<string>) => void
		const iterator = {
			next: () =>
				new Promise<IteratorResult<string>>((resolve) => {
					resolveRead = resolve
				}),
			[Symbol.asyncIterator]() {
				return this
			},
		}
		sandbox.stub(terminal, "shellIntegration").get(() => ({
			executeCommand: () => ({
				read: () => iterator,
			}),
		}))
		const sendTextSpy = sandbox.spy(terminal, "sendText")
		const runPromise = process.run(terminal, "long-command")
		await sandbox.clock.tickAsync(0)

		process.terminate()
		sendTextSpy.calledWith("\u0003", false).should.be.true()
		resolveRead({ value: "", done: true })
		await runPromise
		assert.equal(process.getCompletionDetails().signal, "SIGINT")
	})

	it("should detach listeners without reporting completion before the real exit", async () => {
		const terminal = TerminalRegistry.createTerminal().terminal
		createdTerminals.push(terminal)
		const pendingReads: Array<(value: IteratorResult<string>) => void> = []
		let readCount = 0
		const iterator = {
			next: () => {
				readCount++
				return new Promise<IteratorResult<string>>((resolve) => {
					pendingReads.push(resolve)
				})
			},
			[Symbol.asyncIterator]() {
				return this
			},
		}
		sandbox.stub(terminal, "shellIntegration").get(() => ({
			executeCommand: () => ({
				read: () => iterator,
			}),
		}))
		const completedSpy = sandbox.spy()
		process.on("completed", completedSpy)
		const runPromise = process.run(terminal, "long-command")
		await sandbox.clock.tickAsync(0)
		assert.equal(readCount, 1)

		process.continue()
		await sandbox.clock.tickAsync(0)
		assert.equal(readCount, 1, "detaching must not start a concurrent iterator read")
		sinon.assert.notCalled(completedSpy)

		pendingReads.shift()?.({ value: "background output\n", done: false })
		await sandbox.clock.tickAsync(0)
		assert.equal(readCount, 2)
		sinon.assert.notCalled(completedSpy)

		pendingReads.shift()?.({ value: "", done: true })
		await runPromise
		sinon.assert.calledOnce(completedSpy)
		assert.match(process.getUnretrievedOutput(), /background output/)
	})

	it("does not redispatch a command when shell output observation fails", async () => {
		const terminal = TerminalRegistry.createTerminal().terminal
		createdTerminals.push(terminal)
		let onClosed: ((closed: vscode.Terminal) => unknown) | undefined
		const executeCommand = sandbox.stub().returns({
			read: () => ({
				next: async () => {
					throw new Error("shell output stream disconnected")
				},
				[Symbol.asyncIterator]() {
					return this
				},
			}),
		})
		sandbox.stub(terminal, "shellIntegration").get(() => ({ executeCommand }))
		sandbox.stub(vscode.window, "onDidCloseTerminal").callsFake((listener) => {
			onClosed = listener
			return { dispose: () => undefined }
		})
		const sendText = sandbox.spy(terminal, "sendText")

		const runPromise = process.run(terminal, "npm run migrate")
		await sandbox.clock.tickAsync(0)
		onClosed?.(terminal)
		await runPromise

		sinon.assert.calledOnce(executeCommand)
		sinon.assert.notCalled(sendText)
		assert.equal(process.getCompletionDetails().exitCode, undefined)
		assert.match(process.getCompletionDetails().observationError ?? "", /stream disconnected/)
	})

	it("should abort command and emit warnings on password prompt timeout", async () => {
		const terminal = TerminalRegistry.createTerminal().terminal
		createdTerminals.push(terminal)

		// Use a deferred pattern so we can control when the iterator yields and blocks
		let yieldResolve: ((value: IteratorResult<string>) => void) | null = null
		const mockIterator = {
			yieldCount: 0,
			next(): Promise<IteratorResult<string>> {
				this.yieldCount++
				if (this.yieldCount === 1) {
					// First call: return "Password: " immediately (no newline)
					return Promise.resolve({ value: "Password: ", done: false })
				}
				// Subsequent calls: block forever (simulating hung prompt)
				return new Promise((resolve) => {
					yieldResolve = resolve
				})
			},
			[Symbol.asyncIterator]() {
				return this
			},
		}

		const mockExecuteCommand = sandbox.stub().returns({
			read: () => mockIterator,
		})
		sandbox.stub(terminal, "shellIntegration").get(() => ({
			executeCommand: mockExecuteCommand,
		}))

		const emitSpy = sandbox.spy(process, "emit")
		const runPromise = process.run(terminal, "sudo apt-get update")

		// Let microtasks settle so the first yield is consumed and buffer is filled
		await sandbox.clock.tickAsync(0)

		// Advance timer past 5 seconds to trigger prompt_timeout
		await sandbox.clock.tickAsync(6000)

		// If the run promise hasn't resolved, force-resolve the hung iterator
		if (yieldResolve) {
			;(yieldResolve as (value: IteratorResult<string>) => void)({
				value: "",
				done: true,
			})
		}

		await runPromise

		;(emitSpy as sinon.SinonSpy).calledWith("line", sinon.match("waiting for interactive input")).should.be.true()
		assert.equal(process.getCompletionDetails().exitCode, -1)
	})
})
