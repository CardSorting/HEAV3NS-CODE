<div align="center">

# ⚡ HEAV3NS

### **Your cockpit for the tight coding loop**

*A local-first CLI coding agent for focused, reviewable work.*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22.12%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue?style=for-the-badge)](LICENSE)

<br/>

| **Quick Links** | **Guides & Manuals** | **Deep Dives & Architecture** |
|---|---|---|
| 🚀 [Quick Start](#-quick-start) | 🔮 [Custom Assistants (SOULs & Skills)](SOUL_AND_SKILLS_GUIDE.md) | 📐 [Visual Architecture Maps](docs/ARCHITECTURE_DIAGRAMS.md) |
| 🎯 [Everyday Benefits](#-what-you-get-everyday-superpowers) | ❓ [Frequently Asked Questions](docs/FAQ.md) | 🏗️ [Runtime Architecture Guide](docs/RUNTIME_ARCHITECTURE_GUIDE.md) |
| 👤 [Pick an AI Specialist](#-pick-an-ai-specialist) | ⌨️ [Terminal & Commands Guide](docs/TUI_COMMANDS_GUIDE.md) | 🔍 [Smart Search Engine (ADR-136)](docs/adr/ADR-136-high-velocity-pattern-search-and-zen-io-execution-authority.md) |
| 📋 [What's New](#-whats-new-in-plain-english) | 📖 [Author's Story & Note](PREFACE.md) | ⚡ [Cost-Saving Memory (ADR-135)](docs/adr/ADR-135-zenith-tier-prompt-caching-telemetry-and-auto-tuning-substrate.md) |
| 🧪 [78-Test Verification Suite](scripts/validate-qol-enhancements.ts) | 📈 [Live Benchmark Measurements](docs/LIVE_BASELINE.json) | 🏛️ [Architecture Decision Records](docs/adr/README.md) |
| 🛩️ [Agent Flight Test](agent-flight-test/README.md) | 📊 [Benchmark Methodology](agent-flight-test/METHODOLOGY.md) | 🚀 [Launch & Trust Strategy](agent-flight-test/LAUNCH-STRATEGY.md) |
| 🧾 [Claims & Evidence](.wiki/ip/CLAIM-REGISTER.md) | 🛡️ [Security Policy](SECURITY.md) | ⚖️ [Licensing Strategy](docs/LEGAL-STRATEGY.md) |
| 🤖 [Claude Subscription DirectSDK Provider](docs/CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER.md) | [Rolling QoL Roadmap](ROADMAP.md) | [QoL Audit & Walkthrough](docs/QOL_ROLLING_AUDIT.md) |

---

</div>

**HEAV3NS-CODE native preview:** The macOS AppKit client runs the existing LUMI engine in an owned workspace worker. See the [build and integration guide](docs/desktop/INTEGRATION.md) and [measured release evidence and remaining alpha work](docs/desktop/RELEASE-EVIDENCE.md). This is an integration preview, not the completed v0.1 alpha.

### ⚡ Direct Download for macOS (Apple Silicon)
Get the pre-compiled, signed native binary directly without building from source:
- 💿 **[Direct DMG Download (Apple Silicon)](https://releases.heav3ns.com/HEAV3NS-CODE-latest.dmg)** *(~198MB Universal Disk Image)*
- 📦 **[Direct ZIP Archive](https://releases.heav3ns.com/HEAV3NS-CODE-v0.1.0-macOS-arm64.zip)** *(~176MB Standalone)*
- 🌐 **[Web Storefront & Verified Checksums](https://heav3ns.com/code)** • **[Direct Web Download](https://heav3ns.com/download)** • **[Gumroad ($0+ PWYW)](https://goldeneggie.gumroad.com/l/hkipiu)**

> *Dedicated to the open-source community and the creators at **Nous Research** & **Hermes**. Made with love so anyone can build with fast, reliable AI.*
> — **William Andrew Cruz** (`bozoegg` / `CardSorting`) · [Read Author's Note](PREFACE.md)

---

## Precision at speed. Pilot in command.

Every agent has a flight profile. Cargo planes carry the operation; fighter jets are built for tight turns. HEAV3NS takes the fighter-jet mission: one focused coding task close to the code—inspect context, make a scoped change, verify it, then hand control back to the developer. The metaphor describes our intended use, not a ranking of other agents.

“Break the sound barrier” is our north star for a shorter path from intent to evidence. It is not a measured speed claim. The [Agent Flight Test](agent-flight-test/README.md) checks selected harness behavior with a deterministic local provider; it does not measure live-model coding ability.

Start with the no-key harness check:

```sh
npm run benchmark:flight
```

Read the [test protocol](agent-flight-test/METHODOLOGY.md) or the [adoption and trust plan](agent-flight-test/LAUNCH-STRATEGY.md).

## 🌟 Why Developers Love It

| What You Get | Why It Helps You Every Day | How Fast & Simple It Is |
|---|---|:---:|
| ⚡ **Local-first workflows** | Keeps selected orchestration and review paths close to the editor; provider and network time remain visible as separate costs. | **Measure with the live baseline** |
| 🔍 **Project-aware search** | Finds files and symbols using the workspace's configured search and perception tools. | **Workspace-dependent** |
| ⏪ **Reviewable recovery** | Checkpoints, previews, and rollback paths help inspect changes before committing them. | **External effects are out of scope** |
| 💸 **Cost-aware context** | Tracks context and cache behavior so users can reason about provider usage. | **No savings promise** |
| 🛡️ **Guarded tools** | Permission and safety layers can inspect commands, paths, and tool requests before execution. | **Policy- and host-dependent** |
| 🚀 **Observable runtime** | Health checks, tests, telemetry, and failure states make behavior easier to inspect. | **Not a reliability warranty** |

---

## 🚀 Quick Start

### Option A: 1-Line Automated macOS Install (Recommended)

```bash
# Downloads verified release, mounts DMG, installs to /Applications, and clears Gatekeeper
curl -fsSL https://heav3ns.com/install.sh | bash
```
*Or grab the direct disk image: **[HEAV3NS-CODE-latest.dmg](https://releases.heav3ns.com/HEAV3NS-CODE-latest.dmg)***

### Option B: Build CLI from Source

```bash
# 1. Clone & Build
git clone --recurse-submodules https://github.com/CardSorting/LUMI-JOY.git && cd LUMI-JOY
npm install && npm run build

# 2. Add your AI API key (friendly step-by-step wizard)
npx tsx src/index.ts --setup

# 3. Start coding!
npx tsx src/index.ts --profile coder
```

```text
╔══════════════════════════════════════════════════════════════════════════════════════════╗
║ ⚡ HEAV3NS │ 👤 [💻 Coder] │ 🧠 [configured model] │ ⏱️ local measurement │ 💰 provider usage ║
╠══════════════════════════════════════════════════════════════════════════════════════════╣
║  👤 You: Refactor auth.ts to add expiration checks                                        ║
║  ⚡ HEAV3NS (Coder): Checked auth.ts and applied reviewable edits with unit tests         ║
╠══════════════════════════════════════════════════════════════════════════════════════════╣
║ 💡 Shortcuts: [Ctrl+M] Switch Model  [Ctrl+P] Setup  [/profile] Change Role  [Ctrl+C] Quit ║
╚══════════════════════════════════════════════════════════════════════════════════════════╝
```

### Verify the CLI path

`npm test` runs the CLI-native Mocha unit profile in `.mocharc.cli.json`, then the no-key Agent Flight Test. It keeps host/editor compatibility checks out of the default feedback loop while preserving them as an explicit `npm run test:legacy-host` profile.

---

## 🎯 What You Get (Everyday Superpowers)

| The Common Problem | How HEAV3NS Solves It | Your Real-World Benefit |
|---|---|---|
| **Accidental bad edits or AI mistakes** | Reviewable Recovery | Inspect diffs and use supported checkpoints or rollback paths; external effects may remain. |
| **Fear of AI breaking working code** | Safe Preview Sandbox | Look over proposed edits visually before anything is saved to your computer. |
| **Searches slowing on big projects** | Workspace-Aware Search | Uses bounded search and perception paths whose behavior depends on the workspace. |
| **Typos in function or variable names** | Typo-Friendly Smart Matching | Finds what you're looking for even if you or the AI misspell the name. |
| **Ghost servers locking a port** | Port Diagnostics | Reports and, where permitted, helps resolve port conflicts; it does not bypass host policy. |
| **Expensive AI bills on long chats** | Context and Cache Telemetry | Exposes context behavior and cache signals; provider pricing and savings vary. |
| **Need a smarter model for hard bugs** | Swap AI Models Mid-Chat | Switch among the active provider's supported routes without losing context; Claude account routes are discovered from Claude Code when available. |
| **Want a custom AI teammate** | Drag & Drop Customization | Drop any notes or script files into a folder to create a personalized AI assistant. |

---

## 👤 Pick an AI Specialist

| Specialist | Best For | What It Does For You |
|---|---|---|
| 💻 **`coder` (Lead Engineer)** | Coding & Refactoring | Writes clean code, fixes bugs, cleans up old code, and makes sure tests pass. |
| 🔬 **`researcher` (Deep Researcher)** | Research & Learning | Searches documentation, summarizes web findings, and gives you verified facts. |
| 🛡️ **`sre` (Reliability Engineer)** | Fixing Crashes & Errors | Diagnoses error logs, checks system health, and fixes system problems automatically. |
| ✍️ **`writer` (Technical Author)** | Guides & Documentation | Writes crystal-clear documentation, user guides, and release notes. |
| 🎓 **`student` (Patient Mentor)** | Learning & Onboarding | Breaks down difficult code into friendly, step-by-step explanations. |
| ⚡ **`minimal` (Focused Script)** | Focused Automation | Gets straight to work on quick file edits with a deliberately small context. |

---

## 📋 What's New in Plain English

| Feature | What It Means in Everyday Words | Why You'll Love It |
|---|---|---|
| **⚡ Search & review tools (ADR-136)** | • Project-aware search and typo-tolerant matching.<br/>• Port diagnostics subject to host permissions.<br/>• Diff and sandbox review before supported mutations. | **Inspectable workflows whose performance depends on workload and host.** |
| **🧠 Context and cache telemetry (ADR-135)** | • Tracks reusable context and provider-facing cache signals.<br/>• Reports measurements from the configured provider and model.<br/>• Keeps cost estimates separate from provider billing. | **Better visibility into usage; no universal savings claim.** |

> 📜 *See the complete release history in [CHANGELOG.md](CHANGELOG.md).*

---

## 📚 Advanced Developer Reference

| Category | Reference Links |
|---|---|
| 📐 **Architecture** | [Visual Architecture Maps](docs/ARCHITECTURE_DIAGRAMS.md) · [Runtime Guide](docs/RUNTIME_ARCHITECTURE_GUIDE.md) · [Optimization Record](docs/RUNTIME_OPTIMIZATION_RECORD.md) · [Master ADR Index](docs/adr/README.md) |
| 🎓 **Research & Evidence** | [AKD-DSO Academic Paper](.wiki/whitepaper/AKD-DSO-ACADEMIC-WHITEPAPER.md) · [Live Baseline Measurements](docs/LIVE_BASELINE.json) · [Benchmark Report](docs/BENCHMARK_REPORT.md) · [Grand Audit](docs/GRAND_ARCHITECTURAL_AUDIT.md) |
| ⚡ **Source Architecture** | [Composition Root](src/index.ts) · [Engine Factory](src/factories/monolith-factory.ts) · [Tool Registry](src/tooling/extensions/registry/tool-registry.ts) · [Pattern Search Service](src/tooling/extensions/perception/ripgrep-search-service.ts) |

### Latest Verified Workspace Baseline

The historical run below was generated on **2026-08-17T04:06:43.562Z** using Node.js `v23.5.0` on macOS ARM64. It passed:

| Verification lane | Latest result |
|---|---:|
| Pass 192 composition manifest | 566/566 components |
| Runtime capability smoke | 9/9 checks |
| Heterogeneous benchmark suite | 5/5 cases |
| Complete Flappy Bird React + TypeScript + Vite case | 8/8 assertions; 12/12 files |
| Architecture and performance guardrails | 6/6 checks |

*(Measured fast-path execution throughput for that workload: **8506.11 frames/sec**; do not treat it as a universal product metric.)*

---

## 🏛️ Open Source & License

- **Inspiration**: Built with love and inspired by [`hermes-agent`](https://github.com/NousResearch/hermes-agent) by **Nous Research**.
- **License**: Current first-party work is offered under the **Apache License 2.0** ([LICENSE](LICENSE) · [NOTICE](NOTICE) · [CONTRIBUTING.md](CONTRIBUTING.md) · [PATENT-NON-AGGRESSION-PLEDGE.md](PATENT-NON-AGGRESSION-PLEDGE.md)). Dependencies retain their own terms, and names/branding are reserved in [TRADEMARKS.md](TRADEMARKS.md).
