import { build } from "esbuild"

// A bundled fixture has the same import.meta.url as imported src/index.ts.
// Clear argv[1] only in this test executable so its CLI entrypoint stays dormant.
await build({
	entryPoints: ["scripts/fixtures/linux-desktop-worker.ts"],
	outfile: "build/linux-desktop-fixture.mjs",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	external: ["typescript"],
	tsconfig: "tsconfig.json",
	logLevel: "warning",
	banner: {
		js: 'import { createRequire as _fixtureCreateRequire } from "node:module"; const require = _fixtureCreateRequire(import.meta.url); process.argv[1] = undefined;',
	},
})
