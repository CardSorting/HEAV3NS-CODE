# HEAV3NS-CODE 15.0.2 for macOS

Signed, notarized native packages for Apple Silicon and Intel, with stapled app and
DMG tickets. Requires macOS 14 or later. Open the matching DMG, drag HEAV3NS-CODE
to Applications, and launch normally. No Gatekeeper bypass is required.

This native release keeps the bundled LUMI engine at 15.0.1 and adds:

- A verified whole-app release channel with pinned Node and Sparkle dependencies.
- Signed architecture-specific feeds and Ed25519 archive verification before extraction.
- Native automatic-check and download preferences, manual checks, and protected
  restart deferral while any workspace has active work or unsaved edits.
- The same existing update-signing key and a legacy-feed bridge for deployed clients.
- Retirement of unsigned engine hot-updates. The engine now updates with its signed
  app bundle; user workspace state and legacy caches remain preserved.
- A verified terminal installer with architecture selection, checksum/signature and
  Gatekeeper checks, downgrade prevention, and rollback preservation.

Use HEAV3NS-CODE → Check for Updates… or enable automatic checks in the app menu.
Existing Apple Silicon clients can discover this release through their existing
feed. If a prior installation cannot update, use this release's DMG or installer.

Verify each download using `SHA256SUMS.txt` from this release.
