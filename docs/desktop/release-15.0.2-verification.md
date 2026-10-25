# HEAV3NS-CODE 15.0.2 release verification

Release date: 2026-10-25. Native build: 1502. Bundled engine: 15.0.1.
Source: `b19e458`, immutable tag `v15.0.2` in CardSorting/HEAV3NS-CODE.

## Public distribution

- [Published packages and checksums](https://github.com/CardSorting/HEAV3NS-CODE-Releases/releases/tag/v15.0.2), published at 2026-10-25T09:45:38Z.
- Public distribution tag commit: `fbe512c`; signed feed commit: `f348af3`.
- Architecture feeds: `appcast-arm64.xml` and `appcast-x86_64.xml` on the public repository's main branch.
- Legacy arm64 bridge: https://releases.heav3ns.com/appcast.xml.
- R2 compatibility mirror and latest.json published after package and feed verification.
- Existing Ed25519 key retained. No key rotation or unsigned engine update path.

## Apple notarization

All four submissions were Accepted. Both apps and DMGs were stapled; Gatekeeper
accepted the final bundles as Notarized Developer ID. Developer Team: C35F6CCNLU.

| Architecture | Artifact | Submission ID |
| --- | --- | --- |
| arm64 | App | 11e24f58-cd5c-4666-ab60-4120863949a2 |
| arm64 | DMG | e10a5393-3d27-4185-bdec-71a86b19a745 |
| x86_64 | App | 3cdb2eeb-807b-44bf-a95e-840a7f7d0ce3 |
| x86_64 | DMG | 90a502c6-a89d-42a1-92b9-6d4f59a18f5f |

Final packages, SHA256SUMS.txt and submission receipts are under
`build/release/v15.0.2-{arm64,x86_64}/`.

## Validation

- 232 Swift native tests passed.
- 462 desktop runtime tests passed; one existing test pending.
- 15 installer and feed tests passed.
- Both pinned Node 22.22.0 runtimes executed JavaScript successfully.
- Anonymous public asset downloads matched published checksums and final local ZIP bytes.
- Archive signatures and feed signatures verified with the existing Sparkle key.
- A 1501 arm64 fixture using the legacy feed installed 1502.
- A Developer ID signed 1501 Intel fixture using its dedicated feed downloaded,
  verified, extracted and installed 1502. Native menu/preferences checks passed.
- Installed native executables matched the final release archives byte-for-byte.
- Update tests suppressed production-app relaunch and did not open user workspaces.

Validation ran on the current Apple Silicon macOS host, with Intel execution under
Rosetta. A physical Intel machine and macOS 14 were not available for direct testing.

## Local app and Dock correction

The notarized arm64 release is installed at `build/HEAV3NS-CODE.app`.
The prior 15.0.1 app is retained at `build/HEAV3NS-CODE.previous.app`.
Strict code-signature verification and Gatekeeper acceptance pass.

The disposable updater host had omitted its icon while sharing the production
bundle identifier. The test harness now loads the ICNS before Dock activation and
uses accessory activation if the icon is missing. Test bundles were unregistered;
the canonical production bundle was registered again and opened successfully.
The production app's signed resources were not changed.
