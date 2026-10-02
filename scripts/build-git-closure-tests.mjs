import { build } from "esbuild"

// Portable regression executable for the packaged Linux Node runtime. Only the
// unavailable VS Code host is mocked; desktop, agent, scheduler, storage and Git run.
await build({
	stdin: {
		contents: [
			"src/desktop/__tests__/git.test.ts",
			"src/desktop/__tests__/inspection.test.ts",
			"src/desktop/__tests__/file-search.test.ts",
			"src/utils/__tests__/git-inspection.test.ts",
			"src/desktop/__tests__/cas-concurrency.test.ts",
			"src/desktop/__tests__/git-runtime-integration.test.ts",
		]
			.map((file) => `import "./${file}";`)
			.join("\n"),
		resolveDir: process.cwd(),
	},
	outfile: "build/git-closure-linux.mjs",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	external: ["typescript"],
	alias: { vscode: "./src/test/vscode-mock.ts" },
	inject: ["scripts/fixtures/git-test-globals.mjs"],
	tsconfig: "tsconfig.unit-test.json",
	logLevel: "warning",
	banner: {
		js: 'import {createRequire as _require} from "node:module"; const require=_require(import.meta.url); process.argv[1]=undefined;',
	},
})
