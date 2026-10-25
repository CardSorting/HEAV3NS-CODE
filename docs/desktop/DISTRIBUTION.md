# Native macOS distribution

HEAV3NS-CODE's native app, bundled Node runtime, TypeScript engine, and Sparkle
helpers are released as one Developer ID signed, notarized bundle. Requires macOS
14 or later. Apple Silicon and Intel use separate app packages and update feeds.

## Channels and trust

- Public binary channel: `CardSorting/HEAV3NS-CODE-Releases` on GitHub Releases.
- Website: `https://heav3ns.com/code` and `https://heav3ns.com/download`.
- Native feeds: signed `appcast-arm64.xml` and `appcast-x86_64.xml` on the public
  distribution repository's main branch.
- Existing installations retain a migration path through
  `https://releases.heav3ns.com/appcast.xml`. That legacy feed points to the signed
  Apple Silicon bridge release. The existing Ed25519 public key is preserved.
- The old R2 download aliases and `latest.json` remain compatible mirrors. The
  canonical versioned downloads and public checksums come from GitHub Releases.

The private Ed25519 key remains in the login Keychain under Sparkle's existing
`ed25519` account. The Apple Developer ID signing team is `C35F6CCNLU`. The same
Keychain `NovaNotary` notarization profile can authenticate this team's apps; the
profile name is not restricted to Nova. No password or private signing key is
committed, bundled, or placed on the website.

Native updates require signed feeds and signed archives verified before extraction.
Signature-failure expiration is disabled. Automatic checks and optional downloads
are controlled by the app menu and saved user preference. Update restarts wait for
all workspaces to be idle and saved; ordinary quit protections remain in effect.

The separate unsigned engine OTA path is retired. A downloaded legacy engine cache
is preserved on disk but is no longer selected automatically. Explicit developer
CLI/Node overrides remain supported. Public updates replace the whole signed app,
including its engine and runtime, so the executable code has one release identity.

## Prepare and publish

1. Increment `native/Info.plist` marketing version and strictly increasing numeric
   build. Commit, tag `v<version>`, and push the source. Preparation and publication
   require the exact clean tagged source tree.
2. Run for each architecture, sequentially because the CLI build shares `dist/`:

   ```sh
   HEAV3NS_SIGN_IDENTITY='Developer ID Application: BRIGHTMINDS LLC (C35F6CCNLU)' \
   NOTARY_PROFILE=NovaNotary HEAV3NS_BUILD_ARCH=arm64 bash scripts/macos/prepare_release.sh
   HEAV3NS_SIGN_IDENTITY='Developer ID Application: BRIGHTMINDS LLC (C35F6CCNLU)' \
   NOTARY_PROFILE=NovaNotary HEAV3NS_BUILD_ARCH=x86_64 bash scripts/macos/prepare_release.sh
   ```

3. The builder pins official Node archive checksums and Sparkle 2.10.0, signs nested
   helpers and Node before signing the app, notarizes/staples the app, repackages
   its final ZIP, then signs/notarizes/staples the DMG. Outputs and receipts live in
   `build/release/<tag>-<architecture>/`. No quarantine-removal helper is included.
4. Prepare the corresponding public distribution tag and release notes at
   `docs/desktop/release-<version>.md`. Run `bash scripts/macos/publish_release.sh`.
   It verifies both packages, signing identities, notarization, build/architecture,
   and feed configuration, then stages all assets in a draft. Existing signed feed
   history is verified before signing new history; reused or older builds reject.
5. Only complete releases become public. Feed publication downloads public assets,
   verifies checksums and exact ZIP bytes, signs archives and feeds, and updates
   the public feeds last. A failed feed publication can be retried from its matching
   source tag without replacing an already-public package.
6. Update the compatible R2 aliases, release manifest, and legacy appcast only after
   validating the published packages and feeds. The legacy appcast remains arm64;
   new Intel installations use their dedicated feed. Mirror publication reads feeds
   at an immutable Git commit to avoid stale raw-GitHub cache entries. Deploy website instructions
   that use normal installation and signature verification rather than bypasses.

## Install and recover

Open the matching DMG, drag HEAV3NS-CODE to Applications, and launch normally.
The verified terminal installer selects the architecture, pins the app identity and
Developer Team, verifies SHA-256 and Gatekeeper acceptance, refuses a running app,
prevents downgrades, and keeps a rollback copy. `--check` does not install anything.
It updates an existing installation rather than stopping work or silently creating
another app. Workspace files, credentials, histories, and drafts remain outside the
app bundle.

Keep previous public packages and signing-key backups. Roll back application code
by releasing a higher build containing the known-good code, not by overwriting a
public asset or downgrading the feed. Signing/key loss requires deliberate recovery;
never disable verification or clear quarantine to work around a bad release.
