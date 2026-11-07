# 🔮 LUMI SOUL & SKILLS Drop Vaults & Intuitive Customization Guide

## 1. Overview & Architectural Philosophy

LUMI's **SOUL** (Identity, Ethos, Voice) and **SKILLS** (Procedural Capability, Strategy Planning) subsystems provide enterprise-grade agent customizability with zero-friction ergonomics.

### Core Design Principles
1. **Zero-Configuration Drag-and-Drop**: Users can manage personas and capabilities by simply dragging files into dedicated top-level visible workspace directories (`souls/` and `skills/`).
2. **Multi-Format Auto-Sensing**: Ingests Markdown frontmatter, CharacterCard V2 JSON, OpenAI Custom GPT schemas, Anthropic Claude XML prompts, JSON-LD specs, standalone scripts, and raw natural language prompt text.
3. **Approachable Creation Flows for Non-Technical Users**:
   - **One-Shot Natural Language Forge**: Synthesize complete manifests from free-form prompt descriptions.
   - **Interactive 5-Step Guided Wizard Questionnaire**: Step-by-step multiple-choice customizer.
   - **Modular Power-Up Add-On Packs**: 1-click feature extensions (e.g. *allocation-bounded Slabs*, *Retry Resilience*, *Forensic Audit Logs*, *AST Input Firewall*).
   - **Zero-Boilerplate Clone & Modify (Forking)**: Clone existing profiles/skills and customize rules without touching raw boilerplate.
   - **Proactive Linters with 1-Click Auto-Fix ("Doctors")**: Continuous health scoring (0–100) and automatic remediation of missing instructions or rule mismatches.
4. **Deterministic Kernel Checks**:
   - allocation-bounded Contiguous Slab Memory Invariants (16 MB slab).
   - Cryptographic SHA-256 integrity verification on all manifests.
   - Sub-millisecond turn tick latencies (< 0.15 ms) and 8,000+ frames/sec throughput.
   - O(1) state snapshotting and frame rollback (< 0.05 ms SLA).

---

## 2. Workspace Directory Layout

Both vaults reside directly in the workspace root:

```
LUMI-NEW/
├── souls/                                 🔮 SOUL Persona Drop Vault
│   ├── README.md                          <- Instructional usage guide
│   ├── active.soul.md                     <- Live active persona manifest
│   ├── socratic-mentor.soul.md            <- Ready-to-use Socratic Mentor persona
│   ├── game-engine-architect.card.json    <- Ready-to-use CharacterCard V2 persona
│   ├── executive-assistant.gpt.json       <- Ready-to-use OpenAI Custom GPT schema
│   ├── formal-verifier.claude.xml         <- Ready-to-use Anthropic Claude XML prompt
│   └── templates/                         <- Pre-seeded starter templates
│       ├── starter-mentor.soul.md
│       ├── starter-charactercard-v2.json
│       ├── starter-custom-gpt.json
│       └── starter-claude-prompt.xml
│
└── skills/                                ⚡ SKILL Capability Drop Vault
    ├── README.md                          <- Instructional usage guide
    ├── performance-auditor/               <- Ready-to-use performance skill
    │   └── SKILL.md
    ├── code-refactor/                     <- Ready-to-use refactoring skill
    │   └── SKILL.md
    ├── security-sentinel/                 <- Ready-to-use security skill
    │   └── SKILL.md
    └── templates/                         <- Pre-seeded starter templates
        ├── starter-skill/
        │   └── SKILL.md
        └── starter-tool.json
```

---

## 3. Supported File Formats & Auto-Sensing

LUMI inspects the contents and file extensions to automatically determine the schema:

| Format Name | Extensions / Identifiers | Ingestion Behavior | Target Subsystem |
|---|---|---|---|
| **SOUL Markdown** | `.soul.md`, `.md` | Parses YAML frontmatter (`archetype`, `traits`, `axioms`, `styleRules`) | SOUL |
| **CharacterCard V2** | `.card.json`, `.json` | Ingests Tavern / CharacterCard V2 JSON (`data.personality`, `character_book`) | SOUL |
| **OpenAI Custom GPT** | `.gpt.json`, `.json` | Parses OpenAI GPT builder JSON (`instructions`, `conversation_starters`) | SOUL |
| **Anthropic Claude XML** | `.claude.xml`, `.xml` | Parses Claude system prompt XML tags (`<agent_system_prompt>`) | SOUL |
| **Skill Markdown** | `SKILL.md`, `.skill.md`, `.md` | Parses Antigravity / LUMI skill frontmatter (`category`, `tier`, `version`) | SKILLS |
| **OpenAI Tool Schema** | `.tool.json`, `.json` | Converts `function.name`, `parameters` to procedural skill node | SKILLS |
| **Anthropic Tool Spec** | `.claude.xml`, `.tool.xml` | Converts `<tool_description>` tags to skill node | SKILLS |
| **JSON-LD Definition** | `.jsonld`, `.agent.jsonld` | Ingests `@context` schema for agent personas and capabilities | Both |
| **Declarative YAML** | `.skill.yaml`, `.skill.yml` | Parses step-by-step workflow actions | SKILLS |
| **Executable Script** | `.ts`, `.js`, `.py` | Wraps executable script into sandboxed skill tool | SKILLS |
| **Natural Language Text** | `.txt`, `.prompt` | **Auto-Synthesizes** complete manifest / skill from plain English prompt! | Both |

---

## 4. Intuitive Creation Workflows

### Workflow 1: One-Shot Natural Language Prompt Forge
Users describe what they want in plain English. The forge automatically determines the category, tier, traits, guardrails, and SHA-256 hash.

```typescript
// SOUL Synthesis
const mentorSoul = substrate.forgeCustomSoul(
  "A friendly Python tutor that uses Socratic questioning, gives code hints instead of full answers, and maintains a patient tone."
);

// SKILL Synthesis
const perfSkill = skillSubstrate.forgeCustomSkill(
  "A TypeScript performance auditor that asserts 16 MB slab invariants, checks allocation-bounded on hot loops, and reports frame latencies.",
  { tier: "sovereign" }
);
```

---

### Workflow 2: 5-Step Guided Wizard Questionnaire
An interactive multiple-choice flow designed for non-technical users:

```typescript
// Build a complete persona from wizard answers
const auditSoul = substrate.buildFromWizard({
  archetype: "game_engine_architect",
  primaryTone: "rigorous",
  verbosity: "concise",
  safetyLevel: "strict_zero_gc",
  appliedPacks: ["zero_gc_buffer", "adversarial_security"],
});

// Build a custom skill from wizard answers
const auditSkill = skillSubstrate.buildSkillFromWizard({
  name: "Security AST Sentinel",
  domainOrCategory: "security",
  executionMode: "strict_verification",
  initialTier: "master",
  safetyLevel: "read_only_safe",
  appliedPacks: ["adversarial_security"],
});
```

#### Wizard Steps Overview:
1. **Step 1: Purpose & Domain** (`performance`, `architecture`, `debugging`, `security`, `testing`, `workflow`)
2. **Step 2: Execution Mode & Strictness** (`autonomous_scripting`, `interactive_guide`, `strict_verification`, `socratic_mentoring`)
3. **Step 3: Target Mastery Tier** (`novice`, `adept`, `master`, `sovereign`)
4. **Step 4: Safety & Sandboxing Rules** (`read_only_safe`, `mutation_allowed`, `strict_zero_gc`, `air_gapped_isolated`)
5. **Step 5: Modular Power-Up Add-Ons**

---

### Workflow 3: Modular Power-Up Add-On Packs

Power-up packs allow 1-click feature upgrades without rewriting instructions:

| Power-Up ID | Name | Subsystem | Description |
|---|---|---|---|
| `retry_resilience` | Retry Resilience & Fault Tolerance | Both | Exponential backoff, jitter, and automatic recovery handlers. |
| `zero_gc_buffer` | allocation-bounded Memory Slab Buffering | Both | 16 MB typed array slabs and zero dynamic heap allocations on hot loops. |
| `audit_logging` | Forensic Audit Logging | Both | Tamper-evident transaction logs and SHA-256 state tracking. |
| `adversarial_security` | Adversarial Input Firewall | Both | Path traversal sanitization and AST safety boundaries. |
| `rate_limit_guard` | Token Budget & Concurrency Guard | Both | Leaky-bucket throttling and maximum turn execution ceilings. |
| `pedantic_types` | Pedantic TypeScript Invariants | Both | Strict interface constraints and zero `any` policy. |
| `socratic_teaching` | Socratic Teaching & Explanations | SOUL | Explanatory commentary alongside code modifications. |

---

### Workflow 4: Zero-Boilerplate Clone & Modify (Forking)
Fork an existing persona or skill with custom overrides while preserving evolutionary lineage:

```typescript
const enterpriseAuditor = skillSubstrate.cloneAndModifySkill(
  "performance-auditor",
  "enterprise-perf-auditor",
  {
    name: "Enterprise Performance Auditor",
    tier: "sovereign",
    addedRules: ["Enforce maximum latency budget of 0.05 ms."],
    addedTags: ["enterprise", "sla_strict"],
  }
);
```

---

### Workflow 5: Proactive Linters & 1-Click Auto-Fix ("Doctors")
Continuous automated inspection checks for:
- Missing action steps or empty instructions
- Unbounded loops or missing error handling
- Tier / mastery score disconnects (e.g. `sovereign` with low mastery)
- Missing operational categories or safety rules

```typescript
// 1. Lint the skill
const report = skillSubstrate.lintSkillNode("defective-skill");
console.log(`Cohesion Score: ${report.overallCohesionScore}/100, Issues: ${report.issuesCount}`);

// 2. One-click auto-heal
const healedSkill = skillSubstrate.autoFixSkillNode("defective-skill");
// Cohesion score restored to 100/100!
```

---

## 5. Model Tools Reference

### SKILLS Model Tools (`SkillTreeToolSuite` - 56 Tools Total)
- `skill_forge_custom`: Create custom skill in 1 step from natural language prompt.
- `skill_wizard_get_questions`: Fetch 5-step guided wizard questionnaire.
- `skill_wizard_submit`: Build a complete skill from wizard choices.
- `skill_clone_and_modify`: Fork an existing skill node with custom tweaks.
- `skill_list_power_ups`: List modular skill add-on power-up packs.
- `skill_apply_power_up`: Apply a power-up pack to an existing skill node.
- `skill_lint_node`: Proactively inspect a skill for missing instructions or defects.
- `skill_autofix_node`: One-click auto-fix of all detected skill lint issues.
- `skill_sync_directory`: Auto-scan and synchronize dropped skills in `skills/`.
- `skill_export_to_directory`: Export a skill into `skills/` for instant sharing.
- `skill_get_drop_vault_status`: Telemetry on `skills/` drop vault (file count, templates).
- `skill_ingest_dropped_file`: Ingest a single dropped file path into the active skill tree.
- *(+ 44 Core Evolutionary Tree, DAG, Mutation, Trajectory & Strategy Tools)*

### SOUL Model Tools (`SoulToolSuite` - 55 Tools Total)
- `soul_forge_custom`: Synthesize a custom persona from a free-form prompt.
- `soul_wizard_get_questions`: Fetch 5-step guided persona wizard questionnaire.
- `soul_wizard_submit`: Build a complete SOUL profile from wizard choices.
- `soul_clone_and_modify`: Clone and modify an existing persona profile.
- `soul_list_personality_packs`: List modular personality add-on packs.
- `soul_apply_personality_pack`: Apply a personality pack to a SOUL profile.
- `soul_lint_profile`: Proactively audit a SOUL profile for persona cohesion.
- `soul_autofix_profile`: One-click auto-fix of all detected persona defects.
- `soul_sync_directory`: Auto-scan and ingest dropped persona files in `souls/`.
- `soul_export_to_directory`: Export a persona into `souls/` in the user's preferred format.
- `soul_get_drop_vault_status`: Telemetry on `souls/` drop vault.
- `soul_ingest_dropped_file`: Ingest a single dropped persona file by path.
- *(+ 43 Core Ethos, Trait Tuning, Mutation, Threat Guard & Snapshot Tools)*

---

## 6. Gateway Server JSON-RPC 2.0 API Reference

The `MonolithGatewayServer` exposes JSON-RPC 2.0 endpoints for all operations:

```json
// Example: Sync dropped skills from directory
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "skills/syncDirectory",
  "params": {}
}

// Response:
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "report": {
      "directoryPath": "/workspace/skills",
      "filesScanned": 3,
      "loadedCount": 3,
      "failedCount": 0,
      "loadedSkillIds": ["drop-performance-auditor", "drop-code-refactor", "drop-security-sentinel"]
    }
  }
}
```

### Full JSON-RPC Endpoints List

#### Skills Endpoints
- `skills/listNodes`
- `skills/getNode`
- `skills/getDag`
- `skills/getGroupedSkills`
- `skills/getMetrics`
- `skills/auditHealth`
- `skills/forgeCustom`
- `skills/wizardGetQuestions`
- `skills/wizardSubmit`
- `skills/cloneAndModify`
- `skills/listPowerUps`
- `skills/applyPowerUp`
- `skills/lintNode`
- `skills/autoFixNode`
- `skills/syncDirectory`
- `skills/exportToDirectory`
- `skills/getDropVaultStatus`
- `skills/ingestDroppedFile`

#### SOUL Endpoints
- `soul/getManifest`
- `soul/tuneTrait`
- `soul/setAxiom`
- `soul/getSnapshots`
- `soul/createSnapshot`
- `soul/rollback`
- `soul/auditHealth`
- `soul/forgeCustom`
- `soul/wizardGetQuestions`
- `soul/wizardSubmit`
- `soul/cloneAndModify`
- `soul/listPersonalityPacks`
- `soul/applyPersonalityPack`
- `soul/lintProfile`
- `soul/autoFixProfile`
- `soul/syncDirectory`
- `soul/exportToDirectory`
- `soul/getDropVaultStatus`
- `soul/ingestDroppedFile`

---

## 7. Runtime Skill Discovery & Activation Hardening (`ADR-0016` & `ADR-0020`)

In addition to the Drop Vault creation flows, the runtime skill loader ([`src/core/context/instructions/user-instructions/skills.ts`](../src/core/context/instructions/user-instructions/skills.ts) and [`src/core/task/tools/handlers/UseSkillToolHandler.ts`](../src/core/task/tools/handlers/UseSkillToolHandler.ts)) enforces strict security and reliability invariants across both parent conductors and Legion specialists (see [`AGENT_SWARM_GUIDE.md`](AGENT_SWARM_GUIDE.md)):

1. **Bounded & Untrusted Catalog Framing (`clampDescription`)**:
   - Skill descriptions are normalized to single-line text and clamped to **1,000 characters** in conductor prompts (`MAX_SKILL_DESCRIPTION_LENGTH = 1000`) and **300 characters** (up to 50 skills) in specialist prompts (`LegionAgentHost.formatAvailableSkills`).
   - Catalog listings are explicitly framed as untrusted metadata so adversarial text inside a skill description cannot override system or user instructions.
2. **End-to-End `AbortSignal` Propagation & Bounded Single-Flight Reads**:
   - `discoverSkills`, `discoverSkillsWithDiagnostics`, `scanSkillsDirectoryWithDiagnostics`, `loadSkillMetadataWithDiagnostic`, and `getSkillContent` propagate `AbortSignal` (`signal?.throwIfAborted()`) and use `BoundedSingleFlight` (`maxActive: 16`, `maxWaiters: 256`, 5-second timeout) so cancelled turns detach immediately without hanging on slow disk I/O.
3. **Activation-Time Path & Frontmatter Integrity Validation (`getSkillContent`)**:
   - Rejects skill directory names or paths containing `.` prefixes, `..` traversal segments, path separators, or null bytes (`isValidSkillDirName`).
   - Enforces a **512 KB** file size cap (`MAX_SKILL_FILE_SIZE_BYTES = 512 * 1024`) and rejects binary/null-byte corruption or unclosed YAML frontmatter.
   - Re-verifies on every activation that the `SKILL.md` frontmatter `name` matches the directory/skill name and that both `name` and `description` are non-empty, preventing time-of-check to time-of-use (TOCTOU) drift after initial discovery.
4. **Explicit `read_file` Tool Guidance (`UseSkillToolHandler`)**:
   - Upon activating a skill, `UseSkillToolHandler` explicitly instructs the model: *"You may access other files in the skill directory using the read_file tool at: `<skillDirHint>`"*, preventing models from dumping skill files into the interactive terminal via `cat` (`ADR-0016`).

---

## 8. Performance SLAs & Repository Guardrails

The entire system is continuously validated against strict enterprise performance invariants:

1. **allocation-bounded Contiguous Slab**: Exactly 16,777,216 bytes pre-allocated; zero runtime allocations on hot loops.
2. **Sub-Millisecond Turn Tick Latency**: Turn execution time < 0.15 ms (SLA: < 1.0 ms).
3. **Execution Throughput**: Exceeds 8,500 frames/sec (SLA: >= 1,000 frames/sec).
4. **State Rewind Latency**: checkpointed rollback in 0.01 ms p95 (SLA: < 0.1 ms).
5. **Zero Barrel Imports (ADR-012)**: 0 barrel files across the repository.
6. **Base Class Immutability**: All base classes locked and verified intact.
