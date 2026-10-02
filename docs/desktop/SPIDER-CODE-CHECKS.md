# Spider code checks in the agent and native app

Applied to LUMI-NEW on October 1, 2026. Reference audited:
`/Users/bozoegg/Downloads/LUMI/broccolidb/core/policy/spider`.
The reference tree is unchanged; the runtime uses a bounded adaptation rather
than importing a second structural registry or its project-specific layer rules.

## What is connected

Open a saved JavaScript or TypeScript file in the native inspector, then choose
**Check Code** beside its evidence controls, in Workspace Actions, or in the
Workspace menu. The full-height **Code Check** inspector shows findings, source
locations, scope, coverage and the next action. **Open File…** returns to a
reported file. Back/Forward, Find and Reload use existing native inspection
navigation. The timestamp says when the files were checked; Reload reruns the
check. Its tooltip includes the full localized date and time. Findings precede
detailed scope and coverage; incomplete coverage is qualified near the summary.
Report prose uses semantic native colors independent of prior code highlighting.
Changing conversations invalidates pending inspector replies.

**Prepare Review** appends a bounded review request to the existing composer
draft and saves it through the normal draft store. It refuses an oversized draft
without truncating or replacing the user's work. Nothing is submitted until Send.
The review asks LUMI to recheck current files, make warranted targeted repairs,
then rerun this check and the project's ordinary verification.

The agent has **`spider_check {paths: string[]}`** through its actual validating
tool registry. Core tool routing includes it for both supported provider paths.
It reads the same `SpiderPolicyCheck` instance as the native `spider.check`
endpoint, owned by the existing `BroccoliSpiderAuditEngine` in the monolith.
Agent execution uses normal tool validation, cancellation, progress and recorded
tool results. Walkthrough labels it **Check code** and links only scoped files;
completing this operation is not represented as passing project tests.

`spider-check-v1` is advertised only when the desktop lifecycle supplies the
checking port. The endpoint does not submit an instruction, flush context, stage
edits, run project scripts, invoke a provider or apply repairs. Existing run and
activity persistence records agent-issued tool results; native-only inspections
are transient, dated observations rather than a new persisted audit database.

## Checks and evidence

| Check | Result and limit |
| --- | --- |
| Syntax | TypeScript's parser reads JS/TS source and reports concrete line/column diagnostics. This is syntax parsing, not semantic type checking. |
| Static local imports | Import/export declarations, including side-effect imports and re-exports, resolve relative source paths with common extension substitutions and directory indexes. Missing paths are warnings requiring review of project resolver settings. |
| Dependency cycles | Back edges in the scanned static import graph produce advisory findings. A cycle alone does not establish a runtime defect; type-only edges may also participate. |
| Read consistency | Source descriptors and paths are checked around each read and again after scanning. Changed/missing evidence marks coverage incomplete. SHA-256 hashes identify the bytes actually parsed. This is not an atomic workspace snapshot or comparison with a prior persistent graph. |
| Repair handoff | Stable finding IDs, severity, locations, bounded descriptions and plain-language remediation feed both the inspector and model. No generated shell command is executed. |

The parser avoids the existing legacy Spider audit's regex-only heuristics:
extensionless imports are not automatically treated as broken, and commented
imports or TODO text are not promoted to missing symbols. The old public legacy
methods remain unchanged; the new native and agent paths call `policyCheck`.

The resolution approach uses common
[TypeScript extension substitutions](https://www.typescriptlang.org/docs/handbook/modules/reference).
It intentionally does not claim equivalence with all compiler/bundler settings:
package imports, aliases, `paths`, `moduleSuffixes`, dynamic imports, CommonJS
`require`, assets and package export maps are outside its parser/resolver scope.
Findings with source locations and deliberate file navigation follow the
familiar [VS Code diagnostics pattern](https://code.visualstudio.com/docs/editing/editingevolved),
within LUMI's existing AppKit inspection pane.

## Bounds and control behavior

- Strict input: 1–16 workspace-relative JS/TS paths, at most 512 characters each;
  unknown request properties are rejected by the checking service.
- At most 48 parsed files, two dependency levels, 128 KiB per file, 2 MiB of
  source bytes, 512 import declarations and 40 displayed findings. Omission and
  incomplete coverage are explicit. The response contains hashes and findings,
  not full source files.
- An eight-second scan deadline is checked between operations, with an event-loop
  yield between files. Parser work is synchronous within the bounded file size;
  the deadline is cooperative, not hard preemption of a filesystem operation.
- Paths cannot escape the selected canonical workspace. Symlinked files and
  ancestors, `.git`, `.broccolidb` and `node_modules` are excluded. Reads use
  regular-file checks, no-follow/nonblocking opens, strict UTF-8 decoding, and
  identity checks before and after reading. Incomplete/unreadable data never
  produces an unqualified no-findings result.
- One check owns the scanner at a time; another receives a retryable busy error.
  Model cancellation is propagated. Native scans occupy the bounded discovery
  lane, leaving navigation and Stop capacity. A native read timeout fails its view
  locally and ignores a late reply without disconnecting LUMI.
- Reports are not read-cached: repeating the same tool call or Reload observes
  current disk state. Native report validation checks version, requested identity,
  bounded arrays/counts and safe paths before enabling file links or review drafts.

## Audit of the supplied Spider implementation

| Reference | Finding | Applied decision |
| --- | --- | --- |
| `ForensicSpider` | The staged pipeline offers useful evidence and repair structure, but scans synchronously without file/byte limits or workspace/symlink confinement. | Bounded async reads and scoped parser work; no wholesale facade import. |
| `ForensicSpider.audit` / `DiskParityEngine` | Audit refreshes graph nodes from disk before verifying disk parity. This can erase a prior graph/disk mismatch. | Keep source hashes and check read identity across this scan; do not claim persistent graph parity. |
| `resolveScope('changed-files')` | Uses graph-node modification times rather than Git's working/staged change set. | Explicit selected paths and disclosed dependency expansion; no misleading “all changed files” scope. |
| `TypeMirrorEngine` | Searches for tsconfig and builds a synchronous compiler program, potentially including files beyond the selected roots. Its completeness flag covers collected syntactic/semantic diagnostics, not every possible project check. | Keep ordinary project type checks in the established execution/verification flow. The new service does not load or execute project configuration. |
| `RepairDirectiveEngine` | Useful rationale/preconditions, but generated shell strings interpolate file paths and symbols. | Plain-language suggestions and a review draft; no direct repair-command execution. |
| `AgentToolkit` / `AgentDigest` | Useful bounded summaries, priorities and explicit truncation. Budget slicing does not itself bound upstream scan work or every alternate format. | Bound both acquisition and response; share one structured report between model and UI. |
| `AgentCheckInput` | Declarative schema and validators diverge: depth schema caps at three while shared validation checks only non-negative integers; some empty arrays pass shared validation. | One strict runtime input schema for the tool and desktop adapter, with fixed scan limits. |
| Local `BroccoliSpiderAuditEngine` | Constructed by the factory, but not exposed as a registered tool; existing import checks use regex and extension presence as proxies. | Add the shared policy checker, register `spider_check`, expose it on the monolith, and keep its scope distinct from legacy health scores. |

Full compiler diagnostics, symbol-contract proofs, semantic footprints, layer
policy enforcement, persistent graph baselines/deltas, automatic repairs and
SARIF/CI export remain separate integrations. This pass does not fabricate their
availability or replace the existing project checks and recovery controls.

## Verification

Runtime tests exercise real filesystem parsing and resolution, missing imports,
syntax positions, advisory cycles, depth/byte/finding limits, unsafe/symlink paths,
UTF-8 failures, cancellation, shared ownership, fresh repeated registry results,
core routing, native capability negotiation and preserved control capacity.
Native tests cover report validation, file navigation history, incomplete states,
draft preservation/size limits, semantic report formatting and local timeout handling.

October 1 validation: TypeScript checking passed; the desktop runtime suite passed
213 tests and the native suite passed 182 tests. Logs are
`build/spider-runtime-tests.log` and `build/spider-native-tests.log`.

`scripts/verify-desktop-spider.ts` drives the packaged app with synthetic sources.
It checks file inspection, real findings, Find, native navigation, review draft
preparation and light/dark/compact layouts. The fixture author creates a missing
dependency; Reload must report the now-resolved import. No provider instruction
or automatic repair is submitted. This does not establish live-provider repair
quality, complete accessibility certification or notarized distribution.

The final packaged fixture passed at
`build/desktop-spider-1790907825233/evidence.json`, with no stderr diagnostics.
The same directory contains light/dark, compact Find, preserved review-draft,
file-navigation and refreshed-report captures. `build/spider-build.log` records
the successful app build and verified ad-hoc development signature.

The native finish reviewer returned **ship at the scope of three corrections**:
semantic report color, findings-first compact reading order and dated observations
were all scored resolved against the five replacement captures and source. This
verdict is limited to those corrections, not a whole-application certification.
