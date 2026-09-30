# License boundary map

**Status:** release-control record; review when files or package boundaries change

This map prevents the root Apache-2.0 label from being read as a blanket
relicense of every file in the repository. A consumer should inspect the
file-level license and notice that applies to the exact material being used.

| Path or artifact | Governing terms | Release treatment |
|---|---|---|
| Current first-party project files without a more specific notice | Apache License 2.0 (LICENSE) | May be distributed under Apache-2.0 only where the contributor has the right to grant it. |
| src/core/joyride/** | MIT (src/core/joyride/LICENSE) | Preserve the nested MIT license and its attribution. Do not describe this subtree as exclusively Apache-2.0. |
| BROCCOLIQUEUE/** | MIT (BROCCOLIQUEUE/LICENSE) | Runtime builds bundle this local source and copy its full notice to dist/BROCCOLIQUEUE-LICENSE. |
| Commits and tags before Apache adoption commit c1405ab | Historical license at that exact revision; known pre-adoption state included MIT | Read the exact revision's license before redistribution. |
| node_modules/**, provider SDKs, fonts, icons, and generated assets | Individual dependency or asset terms | Preserve upstream notices and comply with each applicable license. |
| locales/** and translated documentation | File history and any embedded attribution/notice | Treat attribution as unresolved until the source, license, and permission are verified. |
| package-lock.json dependency graph | Each package's declared license and notice | The root Apache field does not override dependency terms. |

## Release rule

If a file falls outside the first row and its license or provenance cannot be
verified, it is a release blocker. Remove it from the artifact, preserve its
original terms, or establish permission before publishing. A repository
copyright header, package metadata field, or migration comment is not proof of
ownership or a license grant.
