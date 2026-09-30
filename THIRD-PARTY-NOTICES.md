# Third-party notices

The first-party work in this repository is offered under the Apache License,
Version 2.0. The Apache license does not relicense dependencies, generated
assets, provider SDKs, fonts, icons, or other third-party material.

The authoritative dependency versions are recorded in `package-lock.json`.
Bundled dependency directories retain their own license and notice files when
they are included in a VSIX or another release artifact. The release checks
verify that the top-level `LICENSE`, `NOTICE`, this file, and the trademark
policy survive the package boundary; they do not replace the license terms of
any dependency.

The lockfile currently includes components under multiple licenses, including
Apache-2.0, MIT, BSD, ISC, LGPL, CC-BY, Unlicense, and other declared terms.
Consumers must review the license file for a dependency they redistribute and
must comply with any applicable attribution, notice, source-offer, or other
condition. A dependency's license is not evidence that the project itself is
licensed under that dependency's terms.

The repository also contains separately licensed nested components:

- src/core/joyride/** carries the MIT license in
  src/core/joyride/LICENSE. Preserve that notice when the subtree is
  redistributed; the root Apache-2.0 metadata does not relicense it.
- BROCCOLIQUEUE/** carries the MIT license in BROCCOLIQUEUE/LICENSE. Its queue
  implementation is bundled into the runtime from source. Builds preserve the
  full notice as dist/BROCCOLIQUEUE-LICENSE, including in the native app bundle.

The complete repository boundary is summarized in
LICENSE-MAP.md. Project acknowledgments for referenced research or
software are kept in NOTICE and the provenance records under .wiki/ip/.

## HEAV3NS-CODE native integration preview

The local `.app` builder bundles the official Node.js 22.22.0 darwin-arm64
runtime. Preserve `Contents/Resources/NODE-LICENSE`, which contains the
upstream MIT license and the runtime's third-party component notices.
The included TypeScript package retains its own license and notices in
`Contents/Resources/runtime/node_modules/typescript`. Existing CLI dependency
notices remain controlling. This local packaging proof does not clear the
repository's outstanding source-provenance release gate.
