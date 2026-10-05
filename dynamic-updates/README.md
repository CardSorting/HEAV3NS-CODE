# ⚡ HEAV3NS-CODE Dynamic Update System

This directory demonstrates and operationalizes the **Hybrid Remote Update Strategy** for HEAV3NS-CODE.

With this system, **users only download the DMG once**. All subsequent updates are delivered automatically and remotely.

---

## 🏗️ Architecture & Update Mechanics

```
                           DEVELOPER PUBLISHES UPDATE
                                       │
            ┌──────────────────────────┴──────────────────────────┐
            ▼                                                     ▼
┌───────────────────────┐                             ┌───────────────────────┐
│  Tier 1: Native App   │                             │  Tier 2: Agent Engine │
│  (Swift GUI / Node)   │                             │  (Prompts / Tools /   │
│  Infrequent Updates   │                             │   Agent Core in src/) │
└───────────┬───────────┘                             │  Frequent Updates     │
            │                                         └───────────┬───────────┘
            ▼                                                     ▼
┌───────────────────────┐                             ┌───────────────────────┐
│ `npm run package:dmg` │                             │ `npm run publish:ota` │
│ - Builds .app & .dmg  │                             │ - Compiles dist/      │
│ - Creates signed .zip │                             │ - Makes 7MB .tar.gz   │
│ - Signs appcast.xml   │                             │ - Hashes SHA-256      │
└───────────┬───────────┘                             └───────────┬───────────┘
            │                                                     │
            └──────────────────────────┬──────────────────────────┘
                                       ▼
                    ┌─────────────────────────────────────┐
                    │      Cloudflare Edge CDN (R2)       │
                    │      `releases.heav3ns.com`         │
                    └──────────────────┬──────────────────┘
                                       │
            ┌──────────────────────────┴──────────────────────────┐
            ▼                                                     ▼
 ┌─────────────────────┐                               ┌─────────────────────┐
 │    Sparkle 2.0      │                               │    EngineManager    │
 │ (In-App macOS GUI)  │                               │ (Swift Background)  │
 ├─────────────────────┤                               ├─────────────────────┤
 │ - Pings appcast.xml │                               │ - Pings .json       │
 │ - EdDSA signature   │                               │ - Verifies SHA-256  │
 │ - Swaps .app bundle │                               │ - Unpacks to        │
 │ - Clean relaunch    │                               │   ~/Library/AppSupp │
 └─────────────────────┘                               │ - Hot-boots on start│
                                                       └─────────────────────┘
```

---

## 📁 What Is in This Directory

| File | Purpose |
| :--- | :--- |
| [`deploy-update.sh`](./deploy-update.sh) | **Unified release CLI:** Push hot engine patches or full native DMG/ZIP releases to Cloudflare R2 with one command. |
| [`demo-ota-cycle.sh`](./demo-ota-cycle.sh) | **Interactive Demo:** Simulates the entire lifecycle of an OTA update locally (checks remote, builds, verifies checksum, unpacks to Application Support sandbox). |
| [`verify-sparkle-feed.sh`](./verify-sparkle-feed.sh) | **Feed Validator:** Tests live `appcast.xml` on `releases.heav3ns.com`, validates EdDSA signatures, and checks zip enclosure health. |
| [`client-simulation.ts`](./client-simulation.ts) | **Client Inspector:** Demonstrates the exact logic `EngineManager.swift` runs on user Macs when resolving and hot-updating the CLI engine. |

---

## 🚀 Quickstart: How to Push Updates

### 1. Check Remote Release Health
Verify that your Cloudflare R2 bucket and `releases.heav3ns.com` endpoints are live:
```bash
./dynamic-updates/deploy-update.sh status
```

### 2. Push a Hot Engine Update (95% of Changes)
When you modify TypeScript code in `src/` (prompts, tools, models, agent workflows):
```bash
./dynamic-updates/deploy-update.sh engine
```
**What happens:**
1. Esbuild compiles `dist/index.js`.
2. Packages a 7MB `engine-v*.tar.gz` and computes its cryptographic SHA-256 hash.
3. Deploys `engine-latest.json` and the archive to Cloudflare R2 (`releases.heav3ns.com`).
4. **User experience:** Next time users launch the app, `EngineManager` detects the new version, downloads it silently in the background, unpacks it into `~/Library/Application Support/HEAV3NS-CODE/runtime/dist/`, and launches the updated engine. No DMG re-download, no Gatekeeper prompt, no drag-and-drop.

### 3. Push a Native Application Update (Swift GUI / Version Bump)
When you modify Swift code or update the bundled Node runtime:
```bash
./dynamic-updates/deploy-update.sh native
```
**What happens:**
1. Compiles the native Swift application with Sparkle linked.
2. Packages the DMG and standalone ZIP.
3. Automatically runs Sparkle's `generate_appcast` to sign the archive with your EdDSA private key.
4. Uploads the ZIP, `appcast.xml`, and updated DMG to Cloudflare R2.
5. **User experience:** Existing users get a native macOS prompt: *"HEAV3NS-CODE 0.2.0 is available! [Install and Relaunch]"*. Sparkle replaces `/Applications/HEAV3NS-CODE.app` in-place.

---

## 🔍 How Engine Precedence Works on User Macs

In `native/Sources/Heav3nsCode/EngineManager.swift`, the runtime resolves the CLI via:

1. **CLI Override / Environment Flag**:
   If `HEAV3NS_CLI` is explicitly set in terminal, it runs that (for dev/debugging).
2. **Downloaded OTA Engine in Application Support**:
   `~/Library/Application Support/HEAV3NS-CODE/runtime/dist/index.js`
   *(If an OTA update has been downloaded and verified, this takes precedence).*
3. **Bundled Factory Engine**:
   `HEAV3NS-CODE.app/Contents/Resources/runtime/dist/index.js`
   *(Safe factory fallback that is always present inside the app bundle).*

---

## 🛡️ Security & Integrity

- **Sparkle Updates:** Cryptographically signed with **EdDSA (ed25519)** keys. Even with ad-hoc development signatures, Sparkle enforces cryptographic authenticity before replacing the application bundle.
- **OTA Engine Updates:** Verified with strict **SHA-256** checksum matching before extracting into Application Support. If a download is corrupted or intercepted, it is rejected and safely falls back to the factory engine.
