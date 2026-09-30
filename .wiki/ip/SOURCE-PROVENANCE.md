# Source provenance record

**Document ID:** `IP-2026-09-21-LUMI-PROVENANCE-01`

**Status:** release-blocked; human evidence review required before distribution

The machine-readable release decision is recorded in
[`SOURCE-RELEASE-MANIFEST.json`](./SOURCE-RELEASE-MANIFEST.json). The
repository deliberately fails `npm run provenance:check` while any listed
surface remains unverified. This is an engineering control, not a legal
finding or a substitute for a rights holder's permission.

## First-party repository record

The visible repository history is authored under the `CardSorting` identity.
That history is useful evidence of who made a commit; it is not, by itself, a
copyright assignment or a complete chain-of-title record. Contributors remain
responsible for the rights they certify through the DCO.

The current project line is Apache-2.0. Files that came from another person,
organization, or license must retain their original notices and must not be
silently swept into the first-party Apache grant.

## Known dependency and migration boundaries

| Source or reference | Repository treatment | License/notice control |
|---|---|---|
| `@noorm/broccolidb` | Pinned to the public `CardSorting/ABroccoliDB` commit recorded in `package.json` and `package-lock.json`. | The dependency's own Apache-2.0 package, `LICENSE`, `NOTICE`, and other notices remain controlling for that dependency. |
| `BROCCOLIQUEUE/**` | Public `CardSorting/BROCCOLIQUEUE`, pinned by the Git submodule entry at `BROCCOLIQUEUE`; `.gitmodules` records its source URL. Local runtime integration and recovery changes are committed in that source repository. | MIT under `BROCCOLIQUEUE/LICENSE`. Builds bundle the source and preserve the full notice as `dist/BROCCOLIQUEUE-LICENSE`, including inside the native app. The root Apache-2.0 label does not relicense this component. |
| Historical `codemarie-new` migration annotations | Several first-party files retain comments identifying an internal migration source. Those comments are provenance pointers, not a license grant. | The steward must confirm authorship or preserve the source license before distributing any affected material as first-party Apache-2.0 work. |
| Hermes Agent / Nous Research | Documentation records architectural inspiration and attribution. | No blanket code-copy or relicensing claim is made; consult the upstream MIT license and any file-level notices if code is included. |
| StateM and related research | Documentation records workflow and evaluation inspiration. | No ownership, endorsement, or code-inclusion claim is made by this repository. |
| Provider SDKs, fonts, icons, and generated assets | Distributed according to their individual package or asset terms. | See `package-lock.json`, dependency license files, and `THIRD-PARTY-NOTICES.md`. |

| src/core/joyride/** | Retained as a separately licensed nested component. | Preserve src/core/joyride/LICENSE (MIT); the root Apache-2.0 label does not relicense this subtree. |
| locales/** and translated documentation | Present in the repository with embedded attribution that is not sufficient to establish chain of title. | Verify the source repository, applicable license, and permission before shipping translations or treating them as first-party Apache-2.0 material. |

## Native integration preview — September 29, 2026

- `native/`, `src/desktop/`, and the desktop build/verification scripts were authored for the user-supplied HEAV3NS-CODE v0.1 specification with AI coding assistance. AppKit platform documentation informed API usage; no VS Code asset set or external desktop implementation was copied. Existing repository provenance restrictions still apply to the reused CLI bundle.
- The local application build includes the official Node **22.22.0 darwin-arm64** archive from `https://nodejs.org/dist/v22.22.0/node-v22.22.0-darwin-arm64.tar.gz`, SHA-256 `5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640`. Its MIT license and bundled component notices are preserved verbatim as `HEAV3NS-CODE.app/Contents/Resources/NODE-LICENSE`.
- The app also bundles the existing production CLI and its pinned dependencies, and copies the installed TypeScript package with its license files. `package-lock.json` controls those versions; bundling does not resolve outstanding source-release findings.
- SwiftTerm was consulted as the intended terminal component but is not included in this preview. No SwiftTerm dependency or license completion claim is made.
- Native captures and measurement records were generated from the actual local preview and disposable fixtures. Published text evidence makes absolute workspace paths repository-relative. These artifacts establish only the measured checks described in `docs/desktop/RELEASE-EVIDENCE.md`.

## Release rule

If a release contains material whose author or license cannot be established,
the material must be removed, replaced, or separately identified before the
release artifact is published. A source comment alone is not sufficient
permission to redistribute copied code.
