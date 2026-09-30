#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { StateManager } from "./core/storage/StateManager.js"
import { createStorageContext, getStorageDataDirectory } from "./shared/storage/storage-context.js"
import { HostProvider } from "./hosts/host-provider.js"
import { AgentConfig } from "./agents/base/agent-config.js"
import { AcpBridgeServer } from "./agents/extensions/acp/acp-bridge-server.js"
import { AcpSupervisor } from "./agents/extensions/acp/acp-supervisor.js"
import { AdversarialHumanizer } from "./agents/extensions/adversarial/adversarial-humanizer.js"
import { AdversarialScrutinySupervisor } from "./agents/extensions/adversarial/adversarial-scrutiny-supervisor.js"
import { InteractiveSecurityArbiter } from "./agents/extensions/arbiter/interactive-security-arbiter.js"
import { SessionArchiveSupervisor } from "./agents/extensions/archive/session-archive-supervisor.js"
import { AudioContainerSupervisor } from "./agents/extensions/audio_container/audio-container-supervisor.js"
import { DeterministicAudioSniffer } from "./agents/extensions/audio_container/deterministic-audio-sniffer.js"
import { IdentityFederationSupervisor } from "./agents/extensions/auth/identity-federation-supervisor.js"
import { BatchEvaluationSupervisor } from "./agents/extensions/batch/batch-evaluation-supervisor.js"
import { BillingUsageSupervisor } from "./agents/extensions/billing_usage/billing-usage-supervisor.js"
import { DeterministicBillingUsageEngine } from "./agents/extensions/billing_usage/deterministic-billing-usage-engine.js"
import { CdpDialogPolicyEngine } from "./agents/extensions/cdp/cdp-dialog-policy-engine.js"
import { CdpNavigationGuard } from "./agents/extensions/cdp/cdp-navigation-guard.js"
import { CdpSupervisorEngine } from "./agents/extensions/cdp/cdp-supervisor-engine.js"
import { CheckpointKernelSupervisor } from "./agents/extensions/checkpoint/checkpoint-kernel-supervisor.js"
import { ClarifyInquirySupervisor } from "./agents/extensions/clarify/clarify-inquiry-supervisor.js"
import { ContextBudgetCalculator } from "./agents/extensions/compaction/context-budget-calculator.js"
import { ContextCompressionSupervisor } from "./agents/extensions/compaction/context-compression-supervisor.js"
import { DynamicVariableInjector } from "./agents/extensions/compaction/dynamic-variable-injector.js"
import { PromptComposer } from "./agents/extensions/compaction/prompt-composer.js"
import { PromptTemplateEngine } from "./agents/extensions/compaction/prompt-template-engine.js"
import { TokenTruncator } from "./agents/extensions/compaction/token-truncator.js"
import { TrajectoryCompactorEngine } from "./agents/extensions/compaction/trajectory-compactor-engine.js"
import { ComputerUseSupervisor } from "./agents/extensions/computer-use/computer-use-supervisor.js"
import { ContextBreakdownSupervisor } from "./agents/extensions/context_breakdown/context-breakdown-supervisor.js"
import { DeterministicContextBreakdownEngine } from "./agents/extensions/context_breakdown/deterministic-context-breakdown-engine.js"
import { CostGovernanceSupervisor } from "./agents/extensions/cost/cost-governance-supervisor.js"
import { CredentialCircuitBreaker } from "./agents/extensions/credential/credential-circuit-breaker.js"
import { MonolithCredentialManager } from "./agents/extensions/credential/monolith-credential-manager.js"
import { CronLifecycleGuard } from "./agents/extensions/cron/cron-lifecycle-guard.js"
import { MonolithCronScheduler } from "./agents/extensions/cron/monolith-cron-scheduler.js"
import { DaemonSupervisor } from "./agents/extensions/daemon/daemon-supervisor.js"
import { DeadlineSupervisor } from "./agents/extensions/deadline/deadline-supervisor.js"
import { DeterministicDeadlineEngine } from "./agents/extensions/deadline/deterministic-deadline-engine.js"
import { MonolithSwarmDelegator } from "./agents/extensions/delegation/monolith-swarm-delegator.js"
import { SubagentLifecycleGuard } from "./agents/extensions/delegation/subagent-lifecycle-guard.js"
import { ToolDisclosureSupervisor } from "./agents/extensions/disclosure/tool-disclosure-supervisor.js"
import { DeterministicDocExtractor } from "./agents/extensions/doc_extractor/deterministic-doc-extractor.js"
import { DocExtractorSupervisor } from "./agents/extensions/doc_extractor/doc-extractor-supervisor.js"
import { DiagnosticDoctorSupervisor } from "./agents/extensions/doctor/diagnostic-doctor-supervisor.js"
import { EmailSupervisor } from "./agents/extensions/email/email-supervisor.js"
import { DeterministicEnvProbeEngine } from "./agents/extensions/env_probe/deterministic-env-probe-engine.js"
import { EnvProbeSupervisor } from "./agents/extensions/env_probe/env-probe-supervisor.js"
import { EnvironmentSupervisorEngine } from "./agents/extensions/environments/environment-supervisor-engine.js"
import { VerificationEvidenceSupervisor } from "./agents/extensions/evidence/verification-evidence-supervisor.js"
import { AgentEngine } from "./agents/extensions/execution/agent-engine.js"
import { AgentLoopHarness } from "./agents/extensions/execution/agent-loop-harness.js"
import { CodeExecutionSupervisor } from "./agents/extensions/execution/code-execution-supervisor.js"
import { InteractiveModeController } from "./agents/extensions/execution/interactive-mode-controller.js"
import { LoopPhaseController } from "./agents/extensions/execution/loop-phase-controller.js"
import { ToolExecutionGuardSupervisor } from "./agents/extensions/execution_guard/tool-execution-guard-supervisor.js"
import { FaultRecoverySupervisor } from "./agents/extensions/faults/fault-recovery-supervisor.js"
import { DeterministicFileSafetyGuard } from "./agents/extensions/file_safety/deterministic-file-safety-guard.js"
import { FileSafetySupervisor } from "./agents/extensions/file_safety/file-safety-supervisor.js"
import { FuzzyMatcherSupervisor } from "./agents/extensions/fuzzy/fuzzy-matcher-supervisor.js"
import { GatewayDispatcherEngine } from "./agents/extensions/gateway/gateway-dispatcher-engine.js"
import { GatewaySupervisor } from "./agents/extensions/gateway/gateway-supervisor.js"
import { DeterministicGoalEngine } from "./agents/extensions/goals/deterministic-goal-engine.js"
import { GoalSupervisor } from "./agents/extensions/goals/goal-supervisor.js"
import { DeterministicHeredocSanitizer } from "./agents/extensions/heredoc_terminal/deterministic-heredoc-sanitizer.js"
import { HeredocTerminalSupervisor } from "./agents/extensions/heredoc_terminal/heredoc-terminal-supervisor.js"
import { TerminalDiagnosticsEngine } from "./agents/extensions/heredoc_terminal/terminal-diagnostics-engine.js"
import { IntegrationsSupervisor } from "./agents/extensions/integrations/integrations-supervisor.js"
import { WorkspaceIntelligenceEngine } from "./agents/extensions/intelligence/workspace-intelligence.js"
import { KanbanBoardSupervisor } from "./agents/extensions/kanban/kanban-board-supervisor.js"
import { SemanticCodeSupervisor } from "./agents/extensions/lsp/semantic-code-supervisor.js"
import { McpSupervisorEngine } from "./agents/extensions/mcp/mcp-supervisor-engine.js"
import { DeterministicMediaResolver } from "./agents/extensions/media_source/deterministic-media-resolver.js"
import { MediaSourceSupervisor } from "./agents/extensions/media_source/media-source-supervisor.js"
import { ContinuousLearningCurator } from "./agents/extensions/memory/continuous-learning-curator.js"
import { MentionResolver } from "./agents/extensions/mentions/mention-resolver.js"
import { DeterministicNousPortalEngine } from "./agents/extensions/nous_portal/deterministic-nous-portal-engine.js"
import { NousPortalSupervisor } from "./agents/extensions/nous_portal/nous-portal-supervisor.js"
import { DeterministicOsvParser } from "./agents/extensions/osv/deterministic-osv-parser.js"
import { OsvScannerSupervisor } from "./agents/extensions/osv/osv-scanner-supervisor.js"
import { OtlpSupervisor } from "./agents/extensions/otlp/otlp-supervisor.js"
import { AtomicMutationSupervisor } from "./agents/extensions/patch/atomic-mutation-supervisor.js"
import { DeterministicPreflightScanner } from "./agents/extensions/preflight_scanner/deterministic-preflight-scanner.js"
import { PreflightScannerSupervisor } from "./agents/extensions/preflight_scanner/preflight-scanner-supervisor.js"
import { ProcessSupervisorEngine } from "./agents/extensions/process/process-supervisor-engine.js"
import { DeterministicProfileEngine } from "./agents/extensions/profiles/deterministic-profile-engine.js"
import { ProfileSupervisor } from "./agents/extensions/profiles/profile-supervisor.js"
import { PromptCacheSupervisor } from "./agents/extensions/prompt/prompt-cache-supervisor.js"
import { ReasoningSupervisor } from "./agents/extensions/reasoning/reasoning-supervisor.js"
import { SecretRedactionSupervisor } from "./agents/extensions/redaction/secret-redaction-supervisor.js"
import { AgentSlashRouter } from "./agents/extensions/resolution/agent-slash-router.js"
import { AuthStorageVault } from "./agents/extensions/resolution/auth-storage-vault.js"
import { DynamicModelCache } from "./agents/extensions/resolution/dynamic-model-cache.js"
import { EnvironmentKeyResolver } from "./agents/extensions/resolution/environment-key-resolver.js"
import { HttpDispatcherOverlay } from "./agents/extensions/resolution/http-dispatcher.js"
import { ImageModelRegistry } from "./agents/extensions/resolution/image-model-registry.js"
import { LlmProxyGateway } from "./agents/extensions/resolution/llm-proxy-gateway.js"
import { ModelCatalog } from "./agents/extensions/resolution/model-catalog.js"
import { ModelResolver } from "./agents/extensions/resolution/model-resolver.js"
import { ProviderAttributionComposer } from "./agents/extensions/resolution/provider-attribution.js"
import { ReasoningEffortController } from "./agents/extensions/resolution/reasoning-effort-controller.js"
import { BackgroundReviewSupervisor } from "./agents/extensions/review/background-review-supervisor.js"
import { AuxiliaryRouterSupervisor } from "./agents/extensions/router/auxiliary-router-supervisor.js"
import { BroccoliRunbookSubstrate } from "./agents/extensions/runbooks/broccoli-runbook-substrate.js"
import { RunbookSupervisor } from "./agents/extensions/runbooks/runbook-supervisor.js"
import { DeterministicSchemaSanitizerEngine } from "./agents/extensions/schema_sanitizer/deterministic-schema-sanitizer-engine.js"
import { SchemaSanitizerSupervisor } from "./agents/extensions/schema_sanitizer/schema-sanitizer-supervisor.js"
import { DeterministicSelfRepoGuardEngine } from "./agents/extensions/self_repo_guard/deterministic-self-repo-guard-engine.js"
import { SelfRepoGuardSupervisor } from "./agents/extensions/self_repo_guard/self-repo-guard-supervisor.js"
import { SetupWizard } from "./agents/extensions/setup/setup-wizard.js"
import { DeterministicSkillLinterEngine } from "./agents/extensions/skill_linter/deterministic-skill-linter-engine.js"
import { SkillLinterSupervisor } from "./agents/extensions/skill_linter/skill-linter-supervisor.js"
import { AntiDegenerationGuard } from "./agents/extensions/skills/anti-degeneration-guard.js"
import { EvolutionarySkillTreeEngine } from "./agents/extensions/skills/evolutionary-skill-tree-engine.js"
import { SkillStrategyEngine } from "./agents/extensions/skills/skill-strategy-engine.js"
import { SkillTreePromptComposer } from "./agents/extensions/skills/skill-tree-prompt-composer.js"
import { DeterministicSkillsSyncClient } from "./agents/extensions/skills_sync/deterministic-skills-sync-client.js"
import { SkillsSyncSupervisor } from "./agents/extensions/skills_sync/skills-sync-supervisor.js"
import { SkillsHubSupervisor } from "./agents/extensions/skills-hub/skills-hub-supervisor.js"
import { TerminalSkinSupervisor } from "./agents/extensions/skin/terminal-skin-supervisor.js"
import { SoulPromptComposer } from "./agents/extensions/soul/soul-prompt-composer.js"
import { SoulThreatGuard } from "./agents/extensions/soul/soul-threat-guard.js"
import { DeterministicSpeechTextNormalizer } from "./agents/extensions/speech_normalizer/deterministic-speech-text-normalizer.js"
import { SpeechNormalizerSupervisor } from "./agents/extensions/speech_normalizer/speech-normalizer-supervisor.js"
import { DeterministicSpillVault } from "./agents/extensions/spill_vault/deterministic-spill-vault.js"
import { SpillVaultSupervisor } from "./agents/extensions/spill_vault/spill-vault-supervisor.js"
import { DeterministicStealthBrowser } from "./agents/extensions/stealth_browser/deterministic-stealth-browser.js"
import { StealthBrowserSupervisor } from "./agents/extensions/stealth_browser/stealth-browser-supervisor.js"
import { DeterministicStreamDiagEngine } from "./agents/extensions/stream_diag/deterministic-stream-diag-engine.js"
import { StreamDiagSupervisor } from "./agents/extensions/stream_diag/stream-diag-supervisor.js"
import { DeterministicStreamingScrubberEngine } from "./agents/extensions/streaming_scrubber/deterministic-streaming-scrubber-engine.js"
import { StreamingScrubberSupervisor } from "./agents/extensions/streaming_scrubber/streaming-scrubber-supervisor.js"
import { DeterministicSubdirHintEngine } from "./agents/extensions/subdir_hints/deterministic-subdir-hint-engine.js"
import { SubdirHintsSupervisor } from "./agents/extensions/subdir_hints/subdir-hints-supervisor.js"
import { AgentSwarmDispatcher } from "./agents/extensions/swarm/agent-swarm-dispatcher.js"
import { DeterministicTerminalCleanerEngine } from "./agents/extensions/terminal_cleaner/deterministic-terminal-cleaner-engine.js"
import { TerminalCleanerSupervisor } from "./agents/extensions/terminal_cleaner/terminal-cleaner-supervisor.js"
import { DeterministicThreadContextEngine } from "./agents/extensions/thread_context/deterministic-thread-context-engine.js"
import { ThreadContextSupervisor } from "./agents/extensions/thread_context/thread-context-supervisor.js"
import { ThreatFirewallSupervisor } from "./agents/extensions/threat/threat-firewall-supervisor.js"
import { ConversationInsightsEngine } from "./agents/extensions/title_insights/conversation-insights-engine.js"
import { DeterministicTitleGenerator } from "./agents/extensions/title_insights/deterministic-title-generator.js"
import { TitleInsightsSupervisor } from "./agents/extensions/title_insights/title-insights-supervisor.js"
import { DeterministicSpeechTranscriber } from "./agents/extensions/transcription/deterministic-speech-transcriber.js"
import { TranscriptionSupervisor } from "./agents/extensions/transcription/transcription-supervisor.js"
import { DeterministicTurnRetryEngine } from "./agents/extensions/turn_retry/deterministic-turn-retry-engine.js"
import { TurnRetrySupervisor } from "./agents/extensions/turn_retry/turn-retry-supervisor.js"
import { DeterministicUrlSafety } from "./agents/extensions/url_safety/deterministic-url-safety.js"
import { UrlSafetySupervisor } from "./agents/extensions/url_safety/url-safety-supervisor.js"
import { DeterministicV4aPatch } from "./agents/extensions/v4a_patch/deterministic-v4a-patch.js"
import { V4aPatchSupervisor } from "./agents/extensions/v4a_patch/v4a-patch-supervisor.js"
import { MultimodalVisionSupervisor } from "./agents/extensions/vision/multimodal-vision-supervisor.js"
import { VoiceSpeechSupervisor } from "./agents/extensions/voice/voice-speech-supervisor.js"
import { DeterministicWakeWord } from "./agents/extensions/wake_word/deterministic-wake-word.js"
import { WakeWordSupervisor } from "./agents/extensions/wake_word/wake-word-supervisor.js"
import { WalletSupervisor } from "./agents/extensions/wallet/wallet-supervisor.js"
import { WebIntelligenceSupervisor } from "./agents/extensions/web/web-intelligence-supervisor.js"
import { DeterministicWebsitePolicy } from "./agents/extensions/website_policy/deterministic-website-policy.js"
import { WebsitePolicySupervisor } from "./agents/extensions/website_policy/website-policy-supervisor.js"
import { DeterministicGitWorktree } from "./agents/extensions/worktree/deterministic-git-worktree.js"
import { WorktreeSupervisor } from "./agents/extensions/worktree/worktree-supervisor.js"
import type {
	AdversarialRedTeamVerdict,
	AdversarialScrutinyOptions,
	CognitiveDecompositionReport,
	ProvenanceGroundingProof,
} from "./core/contracts/adversarial-scrutiny.contracts.js"
import type { EngineTickInput, EngineTickResult, IAgentEngine } from "./core/contracts/agent.contracts.js"
import type { GameStateSnapshot } from "./core/contracts/session.contracts.js"
import {
	type AgentProviderId,
	CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
	getAgentProviderLabel,
	isClaudeSubscriptionDirectSdkProvider,
	normalizeAgentProvider,
	OPENAI_CODEX_PROVIDER,
} from "./core/providers/provider-ids.js"
import { MonolithFactory, type MonolithFactoryOptions } from "./factories/monolith-factory.js"
import { SessionContext } from "./sessions/base/session-context.js"
import { AcpFineGrainedHunkPatcher } from "./sessions/extensions/acp/acp-fine-grained-hunk-patcher.js"
import { AcpSnapshotManager } from "./sessions/extensions/acp/acp-snapshot-manager.js"
import { AcpSpeculativeChangesetStager } from "./sessions/extensions/acp/acp-speculative-changeset-stager.js"
import { BroccoliAcpSubstrate } from "./sessions/extensions/acp/broccoli-acp-substrate.js"
import { BroccoliAdversarialSubstrate } from "./sessions/extensions/adversarial/broccoli-adversarial-substrate.js"
import { ArbiterSnapshotManager } from "./sessions/extensions/arbiter/arbiter-snapshot-manager.js"
import { BroccoliArbiterSubstrate } from "./sessions/extensions/arbiter/broccoli-arbiter-substrate.js"
import { ArchiveSnapshotManager } from "./sessions/extensions/archive/archive-snapshot-manager.js"
import { BroccoliArchiveSubstrate } from "./sessions/extensions/archive/broccoli-archive-substrate.js"
import { AudioContainerSnapshotManager } from "./sessions/extensions/audio_container/audio-container-snapshot-manager.js"
import { BroccoliAudioContainerSubstrate } from "./sessions/extensions/audio_container/broccoli-audio-container-substrate.js"
import { AuthSnapshotManager } from "./sessions/extensions/auth/auth-snapshot-manager.js"
import { BroccoliAuthSubstrate } from "./sessions/extensions/auth/broccoli-auth-substrate.js"
import { BatchSnapshotManager } from "./sessions/extensions/batch/batch-snapshot-manager.js"
import { BroccoliBatchSubstrate } from "./sessions/extensions/batch/broccoli-batch-substrate.js"
import { BillingUsageSnapshotManager } from "./sessions/extensions/billing_usage/billing-usage-snapshot-manager.js"
import { BroccoliBillingUsageSubstrate } from "./sessions/extensions/billing_usage/broccoli-billing-usage-substrate.js"
import { BroccoliBrowserSubstrate } from "./sessions/extensions/cdp/broccoli-browser-substrate.js"
import { BrowserSnapshotManager } from "./sessions/extensions/cdp/browser-snapshot-manager.js"
import { BroccoliCheckpointSubstrate } from "./sessions/extensions/checkpoint/broccoli-checkpoint-substrate.js"
import { CheckpointSnapshotManager } from "./sessions/extensions/checkpoint/checkpoint-snapshot-manager.js"
import { BroccoliClarifySubstrate } from "./sessions/extensions/clarify/broccoli-clarify-substrate.js"
import { ClarifySnapshotManager } from "./sessions/extensions/clarify/clarify-snapshot-manager.js"
import { BroccoliCompressionSubstrate } from "./sessions/extensions/compaction/broccoli-compression-substrate.js"
import { CompressionSnapshotManager } from "./sessions/extensions/compaction/compression-snapshot-manager.js"
import { SessionCompactor } from "./sessions/extensions/compaction/session-compactor.js"
import { SnapcompactEngine } from "./sessions/extensions/compaction/snapcompact-engine.js"
import { BroccoliDisplaySubstrate } from "./sessions/extensions/computer-use/broccoli-display-substrate.js"
import { DisplaySnapshotManager } from "./sessions/extensions/computer-use/display-snapshot-manager.js"
import { BroccoliContextBreakdownSubstrate } from "./sessions/extensions/context_breakdown/broccoli-context-breakdown-substrate.js"
import { ContextBreakdownSnapshotManager } from "./sessions/extensions/context_breakdown/context-breakdown-snapshot-manager.js"
import { BroccoliCostSubstrate } from "./sessions/extensions/cost/broccoli-cost-substrate.js"
import { CostSnapshotManager } from "./sessions/extensions/cost/cost-snapshot-manager.js"
import { BroccoliCredentialSubstrate } from "./sessions/extensions/credential/broccoli-credential-substrate.js"
import { CredentialSnapshotManager } from "./sessions/extensions/credential/credential-snapshot-manager.js"
import { BroccoliCronSubstrate } from "./sessions/extensions/cron/broccoli-cron-substrate.js"
import { CronSnapshotManager } from "./sessions/extensions/cron/cron-snapshot-manager.js"
import { BroccoliDaemonSubstrate } from "./sessions/extensions/daemon/broccoli-daemon-substrate.js"
import { DaemonSnapshotManager } from "./sessions/extensions/daemon/daemon-snapshot-manager.js"
import { BroccoliDeadlineSubstrate } from "./sessions/extensions/deadline/broccoli-deadline-substrate.js"
import { DeadlineSnapshotManager } from "./sessions/extensions/deadline/deadline-snapshot-manager.js"
import { SubagentBudgetGovernor } from "./sessions/extensions/delegation/subagent-budget-governor.js"
import { SubagentVfsBrancher } from "./sessions/extensions/delegation/subagent-vfs-brancher.js"
import { BroccoliDisclosureSubstrate } from "./sessions/extensions/disclosure/broccoli-disclosure-substrate.js"
import { ToolDisclosureSnapshotManager } from "./sessions/extensions/disclosure/disclosure-snapshot-manager.js"
import { BroccoliDocExtractorSubstrate } from "./sessions/extensions/doc_extractor/broccoli-doc-extractor-substrate.js"
import { DocExtractorSnapshotManager } from "./sessions/extensions/doc_extractor/doc-extractor-snapshot-manager.js"
import { BroccoliDoctorSubstrate } from "./sessions/extensions/doctor/broccoli-doctor-substrate.js"
import { DoctorSnapshotManager } from "./sessions/extensions/doctor/doctor-snapshot-manager.js"
import { BroccoliEmailSubstrate } from "./sessions/extensions/email/broccoli-email-substrate.js"
import { EmailSnapshotManager } from "./sessions/extensions/email/email-snapshot-manager.js"
import { BroccoliEnvProbeSubstrate } from "./sessions/extensions/env_probe/broccoli-env-probe-substrate.js"
import { EnvProbeSnapshotManager } from "./sessions/extensions/env_probe/env-probe-snapshot-manager.js"
import { BroccoliEnvironmentSubstrate } from "./sessions/extensions/environments/broccoli-environment-substrate.js"
import { EnvironmentSnapshotManager } from "./sessions/extensions/environments/environment-snapshot-manager.js"
import { BroccoliEvidenceSubstrate } from "./sessions/extensions/evidence/broccoli-evidence-substrate.js"
import { EvidenceSnapshotManager } from "./sessions/extensions/evidence/evidence-snapshot-manager.js"
import { BroccoliExecutionSubstrate } from "./sessions/extensions/execution/broccoli-execution-substrate.js"
import { ExecutionSnapshotManager } from "./sessions/extensions/execution/execution-snapshot-manager.js"
import { BroccoliExecutionGuardSubstrate } from "./sessions/extensions/execution_guard/broccoli-execution-guard-substrate.js"
import { ExecutionGuardSnapshotManager } from "./sessions/extensions/execution_guard/execution-guard-snapshot-manager.js"
import { BroccoliFaultSubstrate } from "./sessions/extensions/faults/broccoli-fault-substrate.js"
import { FaultSnapshotManager } from "./sessions/extensions/faults/fault-snapshot-manager.js"
import { BroccoliFileSafetySubstrate } from "./sessions/extensions/file_safety/broccoli-file-safety-substrate.js"
import { FileSafetySnapshotManager } from "./sessions/extensions/file_safety/file-safety-snapshot-manager.js"
import { BroccoliFuzzySubstrate } from "./sessions/extensions/fuzzy/broccoli-fuzzy-substrate.js"
import { FuzzySnapshotManager } from "./sessions/extensions/fuzzy/fuzzy-snapshot-manager.js"
import { BroccoliGatewaySubstrate } from "./sessions/extensions/gateway/broccoli-gateway-substrate.js"
import { GatewayDeliveryLedger } from "./sessions/extensions/gateway/gateway-delivery-ledger.js"
import { GatewaySnapshotManager } from "./sessions/extensions/gateway/gateway-snapshot-manager.js"
import { BroccoliGoalSubstrate } from "./sessions/extensions/goals/broccoli-goal-substrate.js"
import { GoalSnapshotManager } from "./sessions/extensions/goals/goal-snapshot-manager.js"
import { BroccoliHeredocTerminalSubstrate } from "./sessions/extensions/heredoc_terminal/broccoli-heredoc-terminal-substrate.js"
import { HeredocTerminalSnapshotManager } from "./sessions/extensions/heredoc_terminal/heredoc-terminal-snapshot-manager.js"
import { BroccoliIntegrationsSubstrate } from "./sessions/extensions/integrations/broccoli-integrations-substrate.js"
import { IntegrationsSnapshotManager } from "./sessions/extensions/integrations/integrations-snapshot-manager.js"
import { PostmortemDiagnostic } from "./sessions/extensions/integrity/postmortem-diagnostic.js"
import { SemanticVersionComparator } from "./sessions/extensions/integrity/semantic-version-comparator.js"
import { StabilityDoctor } from "./sessions/extensions/integrity/stability-doctor.js"
import { SystemHealthAggregator } from "./sessions/extensions/integrity/system-health-aggregator.js"
import { BroccoliKanbanSubstrate } from "./sessions/extensions/kanban/broccoli-kanban-substrate.js"
import { KanbanSnapshotManager } from "./sessions/extensions/kanban/kanban-snapshot-manager.js"
import { BroccoliLspSubstrate } from "./sessions/extensions/lsp/broccoli-lsp-substrate.js"
import { LspSnapshotManager } from "./sessions/extensions/lsp/lsp-snapshot-manager.js"
import { BroccoliMcpSubstrate } from "./sessions/extensions/mcp/broccoli-mcp-substrate.js"
import { McpSnapshotManager } from "./sessions/extensions/mcp/mcp-snapshot-manager.js"
import { BroccoliMediaSourceSubstrate } from "./sessions/extensions/media_source/broccoli-media-source-substrate.js"
import { MediaSourceSnapshotManager } from "./sessions/extensions/media_source/media-source-snapshot-manager.js"
import { BroccoliLearningSubstrate } from "./sessions/extensions/memory/broccoli-learning-substrate.js"
import { LearningSnapshotManager } from "./sessions/extensions/memory/learning-snapshot-manager.js"
import { SemanticKnowledgeGraph } from "./sessions/extensions/memory/semantic-knowledge-graph.js"
import { SessionMemoryStore } from "./sessions/extensions/memory/session-memory-store.js"
import { BroccoliNousPortalSubstrate } from "./sessions/extensions/nous_portal/broccoli-nous-portal-substrate.js"
import { NousPortalSnapshotManager } from "./sessions/extensions/nous_portal/nous-portal-snapshot-manager.js"
import { BroccoliOsvSubstrate } from "./sessions/extensions/osv/broccoli-osv-substrate.js"
import { OsvScannerSnapshotManager } from "./sessions/extensions/osv/osv-snapshot-manager.js"
import { BroccoliOtlpSubstrate } from "./sessions/extensions/otlp/broccoli-otlp-substrate.js"
import { OtlpSnapshotManager } from "./sessions/extensions/otlp/otlp-snapshot-manager.js"
import { BroccoliPatchSubstrate } from "./sessions/extensions/patch/broccoli-patch-substrate.js"
import { PatchSnapshotManager } from "./sessions/extensions/patch/patch-snapshot-manager.js"
import { GatewaySessionRegistry } from "./sessions/extensions/persistence/gateway-session-registry.js"
import { PersistentSessionStore } from "./sessions/extensions/persistence/session-store.js"
import { SnapshotStorageIndex } from "./sessions/extensions/persistence/snapshot-storage-index.js"
import { BroccoliPreflightSubstrate } from "./sessions/extensions/preflight_scanner/broccoli-preflight-substrate.js"
import { PreflightSnapshotManager } from "./sessions/extensions/preflight_scanner/preflight-snapshot-manager.js"
import { BroccoliProcessSubstrate } from "./sessions/extensions/process/broccoli-process-substrate.js"
import { ProcessSnapshotManager } from "./sessions/extensions/process/process-snapshot-manager.js"
import { BroccoliProfileSubstrate } from "./sessions/extensions/profiles/broccoli-profile-substrate.js"
import { ProfileSnapshotManager } from "./sessions/extensions/profiles/profile-snapshot-manager.js"
import { BroccoliPromptCacheSubstrate } from "./sessions/extensions/prompt/broccoli-prompt-cache-substrate.js"
import { PromptCacheSnapshotManager } from "./sessions/extensions/prompt/prompt-cache-snapshot-manager.js"
import { BroccoliReasoningSubstrate } from "./sessions/extensions/reasoning/broccoli-reasoning-substrate.js"
import { ReasoningSnapshotManager } from "./sessions/extensions/reasoning/reasoning-snapshot-manager.js"
import { BroccoliRedactionSubstrate } from "./sessions/extensions/redaction/broccoli-redaction-substrate.js"
import { RedactionSnapshotManager } from "./sessions/extensions/redaction/redaction-snapshot-manager.js"
import { BroccoliReviewSubstrate } from "./sessions/extensions/review/broccoli-review-substrate.js"
import { ReviewSnapshotManager } from "./sessions/extensions/review/review-snapshot-manager.js"
import { AuxiliarySnapshotManager } from "./sessions/extensions/router/auxiliary-snapshot-manager.js"
import { BroccoliAuxiliarySubstrate } from "./sessions/extensions/router/broccoli-auxiliary-substrate.js"
import { BroccoliSchemaSanitizerSubstrate } from "./sessions/extensions/schema_sanitizer/broccoli-schema-sanitizer-substrate.js"
import { SchemaSanitizerSnapshotManager } from "./sessions/extensions/schema_sanitizer/schema-sanitizer-snapshot-manager.js"
import { BroccoliSearchSubstrate } from "./sessions/extensions/search/broccoli-search-substrate.js"
import { SearchSnapshotManager } from "./sessions/extensions/search/search-snapshot-manager.js"
import { BroccoliSelfRepoGuardSubstrate } from "./sessions/extensions/self_repo_guard/broccoli-self-repo-guard-substrate.js"
import { SelfRepoGuardSnapshotManager } from "./sessions/extensions/self_repo_guard/self-repo-guard-snapshot-manager.js"
import { BroccoliSkillLinterSubstrate } from "./sessions/extensions/skill_linter/broccoli-skill-linter-substrate.js"
import { SkillLinterSnapshotManager } from "./sessions/extensions/skill_linter/skill-linter-snapshot-manager.js"
import { BroccoliSkillTreeSubstrate } from "./sessions/extensions/skills/broccoli-skill-tree-substrate.js"
import { DeterministicSkillCurator } from "./sessions/extensions/skills/deterministic-skill-curator.js"
import { SkillTreeSnapshotManager } from "./sessions/extensions/skills/skill-tree-snapshot-manager.js"
import { BroccoliSkillsSyncSubstrate } from "./sessions/extensions/skills_sync/broccoli-skills-sync-substrate.js"
import { SkillsSyncSnapshotManager } from "./sessions/extensions/skills_sync/skills-sync-snapshot-manager.js"
import { BroccoliSkillsHubSubstrate } from "./sessions/extensions/skills-hub/broccoli-skills-hub-substrate.js"
import { SkillsHubSnapshotManager } from "./sessions/extensions/skills-hub/skills-hub-snapshot-manager.js"
import { BroccoliSkinSubstrate } from "./sessions/extensions/skin/broccoli-skin-substrate.js"
import { SkinSnapshotManager } from "./sessions/extensions/skin/skin-snapshot-manager.js"
import { BroccoliSoulSubstrate } from "./sessions/extensions/soul/broccoli-soul-substrate.js"
import { SoulSnapshotManager } from "./sessions/extensions/soul/soul-snapshot-manager.js"
import { BroccoliSpeechNormalizerSubstrate } from "./sessions/extensions/speech_normalizer/broccoli-speech-normalizer-substrate.js"
import { SpeechNormalizerSnapshotManager } from "./sessions/extensions/speech_normalizer/speech-normalizer-snapshot-manager.js"
import { BroccoliSpillVaultSubstrate } from "./sessions/extensions/spill_vault/broccoli-spill-vault-substrate.js"
import { SpillVaultSnapshotManager } from "./sessions/extensions/spill_vault/spill-vault-snapshot-manager.js"
import { BroccoliStealthBrowserSubstrate } from "./sessions/extensions/stealth_browser/broccoli-stealth-browser-substrate.js"
import { StealthBrowserSnapshotManager } from "./sessions/extensions/stealth_browser/stealth-browser-snapshot-manager.js"
import { BroccoliStreamDiagSubstrate } from "./sessions/extensions/stream_diag/broccoli-stream-diag-substrate.js"
import { StreamDiagSnapshotManager } from "./sessions/extensions/stream_diag/stream-diag-snapshot-manager.js"
import { BroccoliStreamingScrubberSubstrate } from "./sessions/extensions/streaming_scrubber/broccoli-streaming-scrubber-substrate.js"
import { StreamingScrubberSnapshotManager } from "./sessions/extensions/streaming_scrubber/streaming-scrubber-snapshot-manager.js"
import { BroccoliSubdirHintsSubstrate } from "./sessions/extensions/subdir_hints/broccoli-subdir-hints-substrate.js"
import { SubdirHintsSnapshotManager } from "./sessions/extensions/subdir_hints/subdir-hints-snapshot-manager.js"
import { BroccoliTwoPhaseCommitCoordinator } from "./sessions/extensions/substrate/broccolidb-2pc-coordinator.js"
import { BroccoliBTreeIndexEngine } from "./sessions/extensions/substrate/broccolidb-btree-index-engine.js"
import { BroccoliBufferPoolManager } from "./sessions/extensions/substrate/broccolidb-buffer-pool-manager.js"
import { BroccoliCdcStream } from "./sessions/extensions/substrate/broccolidb-cdc-stream.js"
import { BroccoliConnectionPool } from "./sessions/extensions/substrate/broccolidb-connection-pool.js"
import { BroccoliConsistentHashRing } from "./sessions/extensions/substrate/broccolidb-consistent-hash-ring.js"
import { BroccoliDeadlockDetector } from "./sessions/extensions/substrate/broccolidb-deadlock-detector.js"
import { BroccoliInvertedIndexEngine } from "./sessions/extensions/substrate/broccolidb-inverted-index-engine.js"
import { BroccoliDatabaseKernel } from "./sessions/extensions/substrate/broccolidb-kernel.js"
import { BroccoliLockAuthority } from "./sessions/extensions/substrate/broccolidb-lock-authority.js"
import { BroccoliLsmStore } from "./sessions/extensions/substrate/broccolidb-lsm-store.js"
import { BroccoliMaterializedViewEngine } from "./sessions/extensions/substrate/broccolidb-materialized-view-engine.js"
import { BroccoliMvccEngine } from "./sessions/extensions/substrate/broccolidb-mvcc-engine.js"
import { BroccoliAdaptivePlanCache } from "./sessions/extensions/substrate/broccolidb-plan-cache.js"
import { BroccoliQueryOptimizer } from "./sessions/extensions/substrate/broccolidb-query-optimizer.js"
import { BroccoliRaftConsensusEngine } from "./sessions/extensions/substrate/broccolidb-raft-consensus.js"
import { BroccoliSagaOrchestrator } from "./sessions/extensions/substrate/broccolidb-saga-orchestrator.js"
import { BroccoliSparseIndexEngine } from "./sessions/extensions/substrate/broccolidb-sparse-index-engine.js"
import { BroccoliTieredKvCache } from "./sessions/extensions/substrate/broccolidb-tiered-kv-cache.js"
import { BroccoliTimeSeriesRollupEngine } from "./sessions/extensions/substrate/broccolidb-timeseries-rollup-engine.js"
import { BroccoliVectorAnnEngine } from "./sessions/extensions/substrate/broccolidb-vector-ann-engine.js"
import { BroccoliVectorEngine } from "./sessions/extensions/substrate/broccolidb-vector-engine.js"
import { FileLockManager, LruCache } from "./sessions/extensions/substrate/file-lock.js"
import { FixedRingBuffer } from "./sessions/extensions/substrate/ring-buffer.js"
import { SnowflakeIdGenerator } from "./sessions/extensions/substrate/snowflake-id-generator.js"
import { SystemDirectoryResolver } from "./sessions/extensions/substrate/system-directory-resolver.js"
import { BroccoliTerminalCleanerSubstrate } from "./sessions/extensions/terminal_cleaner/broccoli-terminal-cleaner-substrate.js"
import { TerminalCleanerSnapshotManager } from "./sessions/extensions/terminal_cleaner/terminal-cleaner-snapshot-manager.js"
import { BroccoliThreadContextSubstrate } from "./sessions/extensions/thread_context/broccoli-thread-context-substrate.js"
import { ThreadContextSnapshotManager } from "./sessions/extensions/thread_context/thread-context-snapshot-manager.js"
import { BroccoliThreatSubstrate } from "./sessions/extensions/threat/broccoli-threat-substrate.js"
import { ThreatSnapshotManager } from "./sessions/extensions/threat/threat-snapshot-manager.js"
import { BroccoliTitleInsightsSubstrate } from "./sessions/extensions/title_insights/broccoli-title-insights-substrate.js"
import { TitleInsightsSnapshotManager } from "./sessions/extensions/title_insights/title-insights-snapshot-manager.js"
import { BroccoliTranscriptionSubstrate } from "./sessions/extensions/transcription/broccoli-transcription-substrate.js"
import { TranscriptionSnapshotManager } from "./sessions/extensions/transcription/transcription-snapshot-manager.js"
import { BroccoliTurnRetrySubstrate } from "./sessions/extensions/turn_retry/broccoli-turn-retry-substrate.js"
import { TurnRetrySnapshotManager } from "./sessions/extensions/turn_retry/turn-retry-snapshot-manager.js"
import { BroccoliUrlSafetySubstrate } from "./sessions/extensions/url_safety/broccoli-url-safety-substrate.js"
import { UrlSafetySnapshotManager } from "./sessions/extensions/url_safety/url-safety-snapshot-manager.js"
import { BroccoliV4aPatchSubstrate } from "./sessions/extensions/v4a_patch/broccoli-v4a-patch-substrate.js"
import { V4aPatchSnapshotManager } from "./sessions/extensions/v4a_patch/v4a-patch-snapshot-manager.js"
import { GitIgnoreFilter } from "./sessions/extensions/vfs/git-ignore-filter.js"
import { SessionVfs } from "./sessions/extensions/vfs/session-vfs.js"
import { WorkspaceTreeWalker } from "./sessions/extensions/vfs/workspace-tree-walker.js"
import { BroccoliVisionSubstrate } from "./sessions/extensions/vision/broccoli-vision-substrate.js"
import { VisionSnapshotManager } from "./sessions/extensions/vision/vision-snapshot-manager.js"
import { BroccoliVoiceSubstrate } from "./sessions/extensions/voice/broccoli-voice-substrate.js"
import { VoiceSnapshotManager } from "./sessions/extensions/voice/voice-snapshot-manager.js"
import { BroccoliWakeWordSubstrate } from "./sessions/extensions/wake_word/broccoli-wake-word-substrate.js"
import { WakeWordSnapshotManager } from "./sessions/extensions/wake_word/wake-word-snapshot-manager.js"
import { BroccoliWalletSubstrate } from "./sessions/extensions/wallet/broccoli-wallet-substrate.js"
import { WalletSnapshotManager } from "./sessions/extensions/wallet/wallet-snapshot-manager.js"
import { BroccoliWebSubstrate } from "./sessions/extensions/web/broccoli-web-substrate.js"
import { WebSnapshotManager } from "./sessions/extensions/web/web-snapshot-manager.js"
import { BroccoliWebsitePolicySubstrate } from "./sessions/extensions/website_policy/broccoli-website-policy-substrate.js"
import { WebsitePolicySnapshotManager } from "./sessions/extensions/website_policy/website-policy-snapshot-manager.js"
import { BroccoliWorktreeSubstrate } from "./sessions/extensions/worktree/broccoli-worktree-substrate.js"
import { WorktreeSnapshotManager } from "./sessions/extensions/worktree/worktree-snapshot-manager.js"
import { AcpPermissionGate } from "./tooling/extensions/acp/acp-permission-gate.js"
import { AcpProtocolCodec } from "./tooling/extensions/acp/acp-protocol-codec.js"
import { AcpToolSuite } from "./tooling/extensions/acp/acp-tool-suite.js"
import { DeterministicAcpEngine } from "./tooling/extensions/acp/deterministic-acp-engine.js"
import { AdversarialToolSuite } from "./tooling/extensions/adversarial/adversarial-tool-suite.js"
import { ApprovalHashLedger } from "./tooling/extensions/arbiter/approval-hash-ledger.js"
import { ArbiterToolSuite } from "./tooling/extensions/arbiter/arbiter-tool-suite.js"
import { SecurityRiskClassifier } from "./tooling/extensions/arbiter/security-risk-classifier.js"
import { DeterministicSessionArchiver } from "./tooling/extensions/archive/deterministic-session-archiver.js"
import { SessionArchiveToolSuite } from "./tooling/extensions/archive/session-archive-tool-suite.js"
import { AudioContainerToolSuite } from "./tooling/extensions/audio_container/audio-container-tool-suite.js"
import { DeterministicAuthFederator } from "./tooling/extensions/auth/deterministic-auth-federator.js"
import { IdentityFederationToolSuite } from "./tooling/extensions/auth/identity-federation-tool-suite.js"
import { BatchEvaluationToolSuite } from "./tooling/extensions/batch/batch-evaluation-tool-suite.js"
import { DeterministicBatchEvaluator } from "./tooling/extensions/batch/deterministic-batch-evaluator.js"
import { BillingUsageToolSuite } from "./tooling/extensions/billing_usage/billing-usage-tool-suite.js"
import { CdpDomSnapshotter } from "./tooling/extensions/cdp/cdp-dom-snapshotter.js"
import { CdpProtocolClient } from "./tooling/extensions/cdp/cdp-protocol-client.js"
import { CdpToolSuite } from "./tooling/extensions/cdp/cdp-tool-suite.js"
import { CheckpointKernelToolSuite } from "./tooling/extensions/checkpoint/checkpoint-kernel-tool-suite.js"
import { DeterministicCasStore } from "./tooling/extensions/checkpoint/deterministic-cas-store.js"
import { ClarifyInquiryToolSuite } from "./tooling/extensions/clarify/clarify-inquiry-tool-suite.js"
import { DeterministicClarifyEngine } from "./tooling/extensions/clarify/deterministic-clarify-engine.js"
import { CompressionToolSuite } from "./tooling/extensions/compaction/compression-tool-suite.js"
import { DeterministicToolPruner } from "./tooling/extensions/compaction/deterministic-tool-pruner.js"
import { HeadTailBudgetGovernor } from "./tooling/extensions/compaction/head-tail-budget-governor.js"
import { ComputerUseToolSuite } from "./tooling/extensions/computer-use/computer-use-tool-suite.js"
import { DeterministicDisplayDriver } from "./tooling/extensions/computer-use/deterministic-display-driver.js"
import { ContextBreakdownToolSuite } from "./tooling/extensions/context_breakdown/context-breakdown-tool-suite.js"
import { CostGovernanceToolSuite } from "./tooling/extensions/cost/cost-governance-tool-suite.js"
import { DeterministicCostGovernor } from "./tooling/extensions/cost/deterministic-cost-governor.js"
import { CredentialToolSuite } from "./tooling/extensions/credential/credential-tool-suite.js"
import { DeterministicCredentialPool } from "./tooling/extensions/credential/deterministic-credential-pool.js"
import { AnchoredCronJobManager } from "./tooling/extensions/cron/anchored-cron-job-manager.js"
import { CronToolSuite } from "./tooling/extensions/cron/cron-tool-suite.js"
import { DeterministicBlueprintCatalog } from "./tooling/extensions/cron/deterministic-blueprint-catalog.js"
import { DaemonToolSuite } from "./tooling/extensions/daemon/daemon-tool-suite.js"
import { DeterministicDaemonEngine } from "./tooling/extensions/daemon/deterministic-daemon-engine.js"
import { DatabaseToolSuite } from "./tooling/extensions/database/database-tools.js"
import { DeadlineToolSuite } from "./tooling/extensions/deadline/deadline-tool-suite.js"
import { AnchoredWorktreeManager } from "./tooling/extensions/delegation/anchored-worktree-manager.js"
import { SwarmToolSuite } from "./tooling/extensions/delegation/swarm-tool-suite.js"
import { DeterministicToolDiscloser } from "./tooling/extensions/disclosure/deterministic-tool-discloser.js"
import { ToolDisclosureToolSuite } from "./tooling/extensions/disclosure/tool-disclosure-tool-suite.js"
import { DocExtractorToolSuite } from "./tooling/extensions/doc_extractor/doc-extractor-tool-suite.js"
import { DeterministicDiagnosticDoctor } from "./tooling/extensions/doctor/deterministic-diagnostic-doctor.js"
import { DiagnosticDoctorToolSuite } from "./tooling/extensions/doctor/diagnostic-doctor-tool-suite.js"
import { DeterministicEmailEngine } from "./tooling/extensions/email/deterministic-email-engine.js"
import { EmailToolSuite } from "./tooling/extensions/email/email-tool-suite.js"
import { EnvProbeToolSuite } from "./tooling/extensions/env_probe/env-probe-tool-suite.js"
import { DockerEnvironmentAdapter } from "./tooling/extensions/environments/docker-environment-adapter.js"
import { EnvironmentToolSuite } from "./tooling/extensions/environments/environment-tool-suite.js"
import { LocalEnvironmentAdapter } from "./tooling/extensions/environments/local-environment-adapter.js"
import { SecretScrubber } from "./tooling/extensions/environments/secret-scrubber.js"
import { MonolithBenchmarkEvaluator } from "./tooling/extensions/evals/benchmark-evaluator.js"
import { FlappyBirdProjectBenchmark } from "./tooling/extensions/evals/flappy-bird-project-benchmark.js"
import { LiveBaselineReporter } from "./tooling/extensions/evals/live-baseline-reporter.js"
import {
	type GrandBenchmarkResult,
	MasterBenchmarkOrchestrator,
} from "./tooling/extensions/evals/master-benchmark-orchestrator.js"
import { type RuntimeSmokeReport, RuntimeSmokeSuite } from "./tooling/extensions/evals/runtime-smoke-suite.js"
import { DeterministicEvidenceLedger } from "./tooling/extensions/evidence/deterministic-evidence-ledger.js"
import { VerificationEvidenceToolSuite } from "./tooling/extensions/evidence/verification-evidence-tool-suite.js"
import { CodeExecutionToolSuite } from "./tooling/extensions/execution/code-execution-tool-suite.js"
import { DeterministicCodeExecutor } from "./tooling/extensions/execution/deterministic-code-executor.js"
import { DeterministicToolSegmenter } from "./tooling/extensions/execution_guard/deterministic-tool-segmenter.js"
import { ToolExecutionGuardToolSuite } from "./tooling/extensions/execution_guard/tool-execution-guard-tool-suite.js"
import { DeterministicErrorClassifier } from "./tooling/extensions/faults/deterministic-error-classifier.js"
import { FaultDiagnosticToolSuite } from "./tooling/extensions/faults/fault-diagnostic-tool-suite.js"
import { JitteredBackoffGovernor } from "./tooling/extensions/faults/jittered-backoff-governor.js"
import { FileSafetyToolSuite } from "./tooling/extensions/file_safety/file-safety-tool-suite.js"
import { DeterministicFuzzyMatcher } from "./tooling/extensions/fuzzy/deterministic-fuzzy-matcher.js"
import { FuzzyMatcherToolSuite } from "./tooling/extensions/fuzzy/fuzzy-matcher-tool-suite.js"
import { DeterministicGatewayEngine } from "./tooling/extensions/gateway/deterministic-gateway-engine.js"
import { GatewayToolSuite } from "./tooling/extensions/gateway/gateway-tool-suite.js"
import { MonolithGatewayServer } from "./tooling/extensions/gateway/monolith-gateway-server.js"
import { DiscordProtocolAdapter } from "./tooling/extensions/gateway/platform-adapters/discord-protocol-adapter.js"
import { SlackProtocolAdapter } from "./tooling/extensions/gateway/platform-adapters/slack-protocol-adapter.js"
import { TelegramProtocolAdapter } from "./tooling/extensions/gateway/platform-adapters/telegram-protocol-adapter.js"
import { WebhookProtocolAdapter } from "./tooling/extensions/gateway/platform-adapters/webhook-protocol-adapter.js"
import { TransportConnectionController } from "./tooling/extensions/gateway/transport-connection-controller.js"
import { GoalToolSuite } from "./tooling/extensions/goals/goal-tool-suite.js"
import { BatchEditAnchorer } from "./tooling/extensions/hashline/batch-edit-anchorer.js"
import { DiffSynthesizer } from "./tooling/extensions/hashline/diff-synthesizer.js"
import { AnchoredHands } from "./tooling/extensions/hashline/hands.js"
import { TabSpacingNormalizer } from "./tooling/extensions/hashline/tab-spacing-normalizer.js"
import { HeredocTerminalToolSuite } from "./tooling/extensions/heredoc_terminal/heredoc-terminal-tool-suite.js"
import { DeterministicIntegrationsEngine } from "./tooling/extensions/integrations/deterministic-integrations-engine.js"
import { IntegrationsToolSuite } from "./tooling/extensions/integrations/integrations-tool-suite.js"
import { DeterministicKanbanEngine } from "./tooling/extensions/kanban/deterministic-kanban-engine.js"
import { KanbanOrchestrationToolSuite } from "./tooling/extensions/kanban/kanban-orchestration-tool-suite.js"
import { DeterministicLspEngine } from "./tooling/extensions/lsp/deterministic-lsp-engine.js"
import { LspCodeIntelligenceToolSuite } from "./tooling/extensions/lsp/lsp-code-intelligence-tool-suite.js"
import { McpClientToolSuite } from "./tooling/extensions/mcp/mcp-client-tool-suite.js"
import { McpHub } from "./tooling/extensions/mcp/mcp-hub.js"
import { McpSecurityScrubber } from "./tooling/extensions/mcp/mcp-security-scrubber.js"
import { McpTransportCodec } from "./tooling/extensions/mcp/mcp-transport-codec.js"
import { MediaSourceToolSuite } from "./tooling/extensions/media_source/media-source-tool-suite.js"
import { LearningCuratorToolSuite } from "./tooling/extensions/memory/learning-curator-tool-suite.js"
import { NousPortalToolSuite } from "./tooling/extensions/nous_portal/nous-portal-tool-suite.js"
import { OsvScannerToolSuite } from "./tooling/extensions/osv/osv-scanner-tool-suite.js"
import { DeterministicOtlpEngine } from "./tooling/extensions/otlp/deterministic-otlp-engine.js"
import { OtlpToolSuite } from "./tooling/extensions/otlp/otlp-tool-suite.js"
import { DeterministicPatchEngine } from "./tooling/extensions/patch/deterministic-patch-engine.js"
import { FileMutationToolSuite } from "./tooling/extensions/patch/file-mutation-tool-suite.js"
import { AstPerceptionEyes } from "./tooling/extensions/perception/ast-eyes.js"
import { BoundedFilePeeker } from "./tooling/extensions/perception/file-peeker.js"
import { FrontmatterParser } from "./tooling/extensions/perception/frontmatter-parser.js"
import { LanguageSyntaxParser } from "./tooling/extensions/perception/language-syntax-parser.js"
import { NativeClipboardBridge } from "./tooling/extensions/perception/native-clipboard.js"
import { RipgrepSearchService } from "./tooling/extensions/perception/ripgrep-search-service.js"
import { UrlContentFetcher } from "./tooling/extensions/perception/url-content-fetcher.js"
import { CommandPathResolver } from "./tooling/extensions/permissions/command-path-resolver.js"
import { CommandPermissionController } from "./tooling/extensions/permissions/command-permission-controller.js"
import { KeybindingsController } from "./tooling/extensions/permissions/keybindings-controller.js"
import { ProcessLifecycleManager } from "./tooling/extensions/permissions/process-lifecycle-manager.js"
import { AgenticCommitGenerator } from "./tooling/extensions/policy/agentic-commit-generator.js"
import { ArchitectureGuardrailGate } from "./tooling/extensions/policy/architecture-guardrail-gate.js"
import { CentennialPassMarker } from "./tooling/extensions/policy/centennial-pass-marker.js"
import { RoadmapCheckpointDigest } from "./tooling/extensions/policy/roadmap-checkpoint-digest.js"
import { RoadmapCompletionGate } from "./tooling/extensions/policy/roadmap-completion-gate.js"
import { PreflightToolSuite } from "./tooling/extensions/preflight_scanner/preflight-tool-suite.js"
import { ProcessOutputRingBuffer } from "./tooling/extensions/process/process-output-ring-buffer.js"
import { ProcessSecuritySandbox } from "./tooling/extensions/process/process-security-sandbox.js"
import { ProcessToolSuite } from "./tooling/extensions/process/process-tool-suite.js"
import { ProfileToolSuite } from "./tooling/extensions/profiles/profile-tool-suite.js"
import { ProgressStreamingEars } from "./tooling/extensions/progress/progress-ears.js"
import { DeterministicPromptCacher } from "./tooling/extensions/prompt/deterministic-prompt-cacher.js"
import { PromptCacheToolSuite } from "./tooling/extensions/prompt/prompt-cache-tool-suite.js"
import { DeterministicReasoningScrubber } from "./tooling/extensions/reasoning/deterministic-reasoning-scrubber.js"
import { ReasoningToolSuite } from "./tooling/extensions/reasoning/reasoning-tool-suite.js"
import { DeterministicSecretRedactor } from "./tooling/extensions/redaction/deterministic-secret-redactor.js"
import { SecretRedactionToolSuite } from "./tooling/extensions/redaction/secret-redaction-tool-suite.js"
import { ArgumentCoercer } from "./tooling/extensions/registry/argument-coercer.js"
import { SkillsIngestor } from "./tooling/extensions/registry/skills-ingestor.js"
import { ToolCallSchemaValidator } from "./tooling/extensions/registry/tool-call-schema-validator.js"
import { ValidatingToolRegistry } from "./tooling/extensions/registry/tool-registry.js"
import { BackgroundReviewToolSuite } from "./tooling/extensions/review/background-review-tool-suite.js"
import { DeterministicReviewEvaluator } from "./tooling/extensions/review/deterministic-review-evaluator.js"
import { AuxiliaryRouterToolSuite } from "./tooling/extensions/router/auxiliary-router-tool-suite.js"
import { DeterministicAuxiliaryRouter } from "./tooling/extensions/router/deterministic-auxiliary-router.js"
import { RunbookToolSuite } from "./tooling/extensions/runbooks/runbook-tool-suite.js"
import { SchemaSanitizerToolSuite } from "./tooling/extensions/schema_sanitizer/schema-sanitizer-tool-suite.js"
import { DeterministicSessionSearchEngine } from "./tooling/extensions/search/deterministic-session-search-engine.js"
import { FtsQuerySanitizer } from "./tooling/extensions/search/fts-query-sanitizer.js"
import { SearchToolSuite } from "./tooling/extensions/search/search-tool-suite.js"
import { SelfRepoGuardToolSuite } from "./tooling/extensions/self_repo_guard/self-repo-guard-tool-suite.js"
import { SkillLinterToolSuite } from "./tooling/extensions/skill_linter/skill-linter-tool-suite.js"
import { AnchoredSkillMutator } from "./tooling/extensions/skills/anchored-skill-mutator.js"
import { DeterministicSkillTreeParser } from "./tooling/extensions/skills/deterministic-skill-tree-parser.js"
import { SkillTreeToolSuite } from "./tooling/extensions/skills/skill-tree-tool-suite.js"
import { SkillsSyncToolSuite } from "./tooling/extensions/skills_sync/skills-sync-tool-suite.js"
import { DeterministicSkillsHub } from "./tooling/extensions/skills-hub/deterministic-skills-hub.js"
import { SkillsHubToolSuite } from "./tooling/extensions/skills-hub/skills-hub-tool-suite.js"
import { DeterministicSkinEngine } from "./tooling/extensions/skin/deterministic-skin-engine.js"
import { TerminalSkinToolSuite } from "./tooling/extensions/skin/terminal-skin-tool-suite.js"
import { AnchoredSoulMutator } from "./tooling/extensions/soul/anchored-soul-mutator.js"
import { DeterministicSoulParser } from "./tooling/extensions/soul/deterministic-soul-parser.js"
import { SoulToolSuite } from "./tooling/extensions/soul/soul-tool-suite.js"
import { SpeechNormalizerToolSuite } from "./tooling/extensions/speech_normalizer/speech-normalizer-tool-suite.js"
import { SpillVaultToolSuite } from "./tooling/extensions/spill_vault/spill-vault-tool-suite.js"
import { StealthBrowserToolSuite } from "./tooling/extensions/stealth_browser/stealth-browser-tool-suite.js"
import { StreamDiagToolSuite } from "./tooling/extensions/stream_diag/stream-diag-tool-suite.js"
import { StreamingScrubberToolSuite } from "./tooling/extensions/streaming_scrubber/streaming-scrubber-tool-suite.js"
import { SubdirHintsToolSuite } from "./tooling/extensions/subdir_hints/subdir-hints-tool-suite.js"
import { ResilientFetchClient } from "./tooling/extensions/telemetry/resilient-fetch-client.js"
import { StderrGuardFilter } from "./tooling/extensions/telemetry/stderr-guard.js"
import { StreamEventFormatter } from "./tooling/extensions/telemetry/stream-event-formatter.js"
import { TelemetryTracer } from "./tooling/extensions/telemetry/telemetry-tracer.js"
import { TerminalTextSanitizer } from "./tooling/extensions/telemetry/text-sanitizer.js"
import { MicrosecondTimingBuffer } from "./tooling/extensions/telemetry/timing-buffer.js"
import { TTSRCoordinator } from "./tooling/extensions/telemetry/ttsr-coordinator.js"
import { TerminalCleanerToolSuite } from "./tooling/extensions/terminal_cleaner/terminal-cleaner-tool-suite.js"
import { ThreadContextToolSuite } from "./tooling/extensions/thread_context/thread-context-tool-suite.js"
import { DeterministicThreatScanner } from "./tooling/extensions/threat/deterministic-threat-scanner.js"
import { ThreatFirewallToolSuite } from "./tooling/extensions/threat/threat-firewall-tool-suite.js"
import { TitleInsightsToolSuite } from "./tooling/extensions/title_insights/title-insights-tool-suite.js"
import { TranscriptionToolSuite } from "./tooling/extensions/transcription/transcription-tool-suite.js"
import { TurnRetryToolSuite } from "./tooling/extensions/turn_retry/turn-retry-tool-suite.js"
import { UrlSafetyToolSuite } from "./tooling/extensions/url_safety/url-safety-tool-suite.js"
import { V4aPatchToolSuite } from "./tooling/extensions/v4a_patch/v4a-patch-tool-suite.js"
import { DeterministicImageCodec } from "./tooling/extensions/vision/deterministic-image-codec.js"
import { MultimodalVisionToolSuite } from "./tooling/extensions/vision/multimodal-vision-tool-suite.js"
import { DeterministicAudioCodec } from "./tooling/extensions/voice/deterministic-audio-codec.js"
import { VoiceSpeechToolSuite } from "./tooling/extensions/voice/voice-speech-tool-suite.js"
import { WakeWordToolSuite } from "./tooling/extensions/wake_word/wake-word-tool-suite.js"
import { DeterministicWalletEngine } from "./tooling/extensions/wallet/deterministic-wallet-engine.js"
import { WalletToolSuite } from "./tooling/extensions/wallet/wallet-tool-suite.js"
import { DeterministicWebEngine } from "./tooling/extensions/web/deterministic-web-engine.js"
import { WebIntelligenceToolSuite } from "./tooling/extensions/web/web-intelligence-tool-suite.js"
import { WebsitePolicyToolSuite } from "./tooling/extensions/website_policy/website-policy-tool-suite.js"
import { WorktreeToolSuite } from "./tooling/extensions/worktree/worktree-tool-suite.js"
import { AcpDashboardModal } from "./tui/components/acp-dashboard-modal.js"

export { AgentConfig } from "./agents/base/agent-config.js"
export { AcpBridgeServer } from "./agents/extensions/acp/acp-bridge-server.js"
export { AcpSupervisor } from "./agents/extensions/acp/acp-supervisor.js"
export { AdversarialHumanizer } from "./agents/extensions/adversarial/adversarial-humanizer.js"
export { AdversarialScrutinySupervisor } from "./agents/extensions/adversarial/adversarial-scrutiny-supervisor.js"
export { InteractiveSecurityArbiter } from "./agents/extensions/arbiter/interactive-security-arbiter.js"
export { SessionArchiveSupervisor } from "./agents/extensions/archive/session-archive-supervisor.js"
export { AudioContainerSupervisor } from "./agents/extensions/audio_container/audio-container-supervisor.js"
export { DeterministicAudioSniffer } from "./agents/extensions/audio_container/deterministic-audio-sniffer.js"
export { IdentityFederationSupervisor } from "./agents/extensions/auth/identity-federation-supervisor.js"
export { BatchEvaluationSupervisor } from "./agents/extensions/batch/batch-evaluation-supervisor.js"
export { BillingUsageSupervisor } from "./agents/extensions/billing_usage/billing-usage-supervisor.js"
export { DeterministicBillingUsageEngine } from "./agents/extensions/billing_usage/deterministic-billing-usage-engine.js"
export { CdpDialogPolicyEngine } from "./agents/extensions/cdp/cdp-dialog-policy-engine.js"
export { CdpNavigationGuard } from "./agents/extensions/cdp/cdp-navigation-guard.js"
export { CdpSupervisorEngine } from "./agents/extensions/cdp/cdp-supervisor-engine.js"
export { CheckpointKernelSupervisor } from "./agents/extensions/checkpoint/checkpoint-kernel-supervisor.js"
export { ClarifyInquirySupervisor } from "./agents/extensions/clarify/clarify-inquiry-supervisor.js"
export type { ContextBudgetInfo, ContextBudgetOptions } from "./agents/extensions/compaction/context-budget-calculator.js"
export { ContextBudgetCalculator } from "./agents/extensions/compaction/context-budget-calculator.js"
export { ContextCompressionSupervisor } from "./agents/extensions/compaction/context-compression-supervisor.js"
export type {
	ContextCheckpointEnvelope,
	ContextDslEnvelope,
	DslEnvelopeMetrics,
	DslIntegrityResult,
	GoalEnvelopePayload,
	MemoryEnvelopePayload,
	ThreadBootstrapEnvelope,
	ToolResultEnvelopePayload,
} from "./agents/extensions/compaction/context-dsl-engine.js"
export { ContextDslEngine } from "./agents/extensions/compaction/context-dsl-engine.js"
export { DynamicVariableInjector } from "./agents/extensions/compaction/dynamic-variable-injector.js"
export { PromptComposer } from "./agents/extensions/compaction/prompt-composer.js"
export { PromptTemplateEngine } from "./agents/extensions/compaction/prompt-template-engine.js"
export type { TokenTruncationOptions } from "./agents/extensions/compaction/token-truncator.js"
export { TokenTruncator } from "./agents/extensions/compaction/token-truncator.js"
export { TrajectoryCompactorEngine } from "./agents/extensions/compaction/trajectory-compactor-engine.js"
export { ComputerUseSupervisor } from "./agents/extensions/computer-use/computer-use-supervisor.js"
export { ContextBreakdownSupervisor } from "./agents/extensions/context_breakdown/context-breakdown-supervisor.js"
export { DeterministicContextBreakdownEngine } from "./agents/extensions/context_breakdown/deterministic-context-breakdown-engine.js"
export { CostGovernanceSupervisor } from "./agents/extensions/cost/cost-governance-supervisor.js"
export { CredentialCircuitBreaker } from "./agents/extensions/credential/credential-circuit-breaker.js"
export { MonolithCredentialManager } from "./agents/extensions/credential/monolith-credential-manager.js"
export { CronLifecycleGuard } from "./agents/extensions/cron/cron-lifecycle-guard.js"
export { MonolithCronScheduler } from "./agents/extensions/cron/monolith-cron-scheduler.js"
export { DaemonSupervisor } from "./agents/extensions/daemon/daemon-supervisor.js"
export { DeadlineSupervisor } from "./agents/extensions/deadline/deadline-supervisor.js"
export { DeterministicDeadlineEngine } from "./agents/extensions/deadline/deterministic-deadline-engine.js"
export { MonolithSwarmDelegator } from "./agents/extensions/delegation/monolith-swarm-delegator.js"
export { SubagentLifecycleGuard } from "./agents/extensions/delegation/subagent-lifecycle-guard.js"
export { ToolDisclosureSupervisor } from "./agents/extensions/disclosure/tool-disclosure-supervisor.js"
export { DeterministicDocExtractor } from "./agents/extensions/doc_extractor/deterministic-doc-extractor.js"
export { DocExtractorSupervisor } from "./agents/extensions/doc_extractor/doc-extractor-supervisor.js"
export { DiagnosticDoctorSupervisor } from "./agents/extensions/doctor/diagnostic-doctor-supervisor.js"
export { EmailSupervisor } from "./agents/extensions/email/email-supervisor.js"
export { DeterministicEnvProbeEngine } from "./agents/extensions/env_probe/deterministic-env-probe-engine.js"
export { EnvProbeSupervisor } from "./agents/extensions/env_probe/env-probe-supervisor.js"
export { EnvironmentSupervisorEngine } from "./agents/extensions/environments/environment-supervisor-engine.js"
export { VerificationEvidenceSupervisor } from "./agents/extensions/evidence/verification-evidence-supervisor.js"
export type { AgentContextServices } from "./agents/extensions/execution/agent-engine.js"
export { AgentEngine } from "./agents/extensions/execution/agent-engine.js"
export type {
	AutonomousHarnessOptions,
	HarnessExecutionResult,
	HarnessStepEvent,
} from "./agents/extensions/execution/agent-loop-harness.js"
export { AgentLoopHarness } from "./agents/extensions/execution/agent-loop-harness.js"
export type { ModeGateResult, ModeState } from "./agents/extensions/execution/broccolidb-mode-controller.js"
export { BroccoliAutomatedModeController } from "./agents/extensions/execution/broccolidb-mode-controller.js"
export { BroccoliMutationPlanner } from "./agents/extensions/execution/broccolidb-mutation-planner.js"
export type { PlanReviewResult } from "./agents/extensions/execution/broccolidb-plan-enforcer.js"
export { BroccoliPlanModeEnforcer } from "./agents/extensions/execution/broccolidb-plan-enforcer.js"
export type { QueryLoopState } from "./agents/extensions/execution/broccolidb-query-loop.js"
export { BroccoliQueryLoopOrchestrator } from "./agents/extensions/execution/broccolidb-query-loop.js"
export type {
	MutationPlan,
	MutationStep,
	RepairDirective,
	RepairExecution,
} from "./agents/extensions/execution/broccolidb-repair-executor.js"
export { BroccoliRepairMutationExecutor } from "./agents/extensions/execution/broccolidb-repair-executor.js"
export type { IntentClassification, SideQueryResult } from "./agents/extensions/execution/broccolidb-side-query.js"
export { BroccoliSideQueryService } from "./agents/extensions/execution/broccolidb-side-query.js"
export { CodeExecutionSupervisor } from "./agents/extensions/execution/code-execution-supervisor.js"
export type {
	SynthesizedFlappyBirdProject,
	SynthesizedProjectFile,
	WrittenFlappyBirdProject,
} from "./agents/extensions/execution/flappy-bird-project-synthesizer.js"
export {
	FLAPPY_BIRD_PROJECT_DIRECTORY,
	FlappyBirdProjectSynthesizer,
} from "./agents/extensions/execution/flappy-bird-project-synthesizer.js"
export { InteractiveModeController } from "./agents/extensions/execution/interactive-mode-controller.js"
export type { LoopPhase, PhaseTransitionEvent } from "./agents/extensions/execution/loop-phase-controller.js"
export { LoopPhaseController } from "./agents/extensions/execution/loop-phase-controller.js"
export { ToolExecutionGuardSupervisor } from "./agents/extensions/execution_guard/tool-execution-guard-supervisor.js"
export { FaultRecoverySupervisor } from "./agents/extensions/faults/fault-recovery-supervisor.js"
export { DeterministicFileSafetyGuard } from "./agents/extensions/file_safety/deterministic-file-safety-guard.js"
export { FileSafetySupervisor } from "./agents/extensions/file_safety/file-safety-supervisor.js"
export { FuzzyMatcherSupervisor } from "./agents/extensions/fuzzy/fuzzy-matcher-supervisor.js"
export { GatewayDispatcherEngine } from "./agents/extensions/gateway/gateway-dispatcher-engine.js"
export { GatewaySupervisor } from "./agents/extensions/gateway/gateway-supervisor.js"
export { DeterministicGoalEngine } from "./agents/extensions/goals/deterministic-goal-engine.js"
export { GoalSupervisor } from "./agents/extensions/goals/goal-supervisor.js"
export { DeterministicHeredocSanitizer } from "./agents/extensions/heredoc_terminal/deterministic-heredoc-sanitizer.js"
export { HeredocTerminalSupervisor } from "./agents/extensions/heredoc_terminal/heredoc-terminal-supervisor.js"
export { TerminalDiagnosticsEngine } from "./agents/extensions/heredoc_terminal/terminal-diagnostics-engine.js"
export { IntegrationsSupervisor } from "./agents/extensions/integrations/integrations-supervisor.js"
export type { BlastRadiusResult, FileDependencyNode } from "./agents/extensions/intelligence/broccolidb-blast-radius.js"
export { BroccoliBlastRadiusCalculator } from "./agents/extensions/intelligence/broccolidb-blast-radius.js"
export type { PromptSuggestion } from "./agents/extensions/intelligence/broccolidb-cognitive-suggestion.js"
export { BroccoliCognitiveSuggestionEngine } from "./agents/extensions/intelligence/broccolidb-cognitive-suggestion.js"
export type { ContradictionReport } from "./agents/extensions/intelligence/broccolidb-epistemic-reasoning.js"
export { BroccoliEpistemicReasoningEngine } from "./agents/extensions/intelligence/broccolidb-epistemic-reasoning.js"
export type {
	CapabilityIntent,
	IntentTrace,
	IntentTracerHealth,
} from "./agents/extensions/intelligence/broccolidb-intent-tracer.js"
export { BroccoliIntentTracer } from "./agents/extensions/intelligence/broccolidb-intent-tracer.js"
export type { SpiderAuditItem, SpiderAuditReport } from "./agents/extensions/intelligence/broccolidb-spider-audit.js"
export { BroccoliSpiderAuditEngine } from "./agents/extensions/intelligence/broccolidb-spider-audit.js"
export type {
	VerificationFinding,
	VerificationReport,
} from "./agents/extensions/intelligence/broccolidb-verification-pipeline.js"
export { BroccoliVerificationPipeline } from "./agents/extensions/intelligence/broccolidb-verification-pipeline.js"
export type {
	GraphTraversalFilter,
	KnowledgeEdge,
	KnowledgeNode,
} from "./agents/extensions/intelligence/knowledge-graph-substrate.js"
export { KnowledgeGraphSubstrate } from "./agents/extensions/intelligence/knowledge-graph-substrate.js"
export type { WorkspaceCognitiveModel } from "./agents/extensions/intelligence/workspace-intelligence.js"
export { WorkspaceIntelligenceEngine } from "./agents/extensions/intelligence/workspace-intelligence.js"
export { KanbanBoardSupervisor } from "./agents/extensions/kanban/kanban-board-supervisor.js"
export { SemanticCodeSupervisor } from "./agents/extensions/lsp/semantic-code-supervisor.js"
export { McpSupervisorEngine } from "./agents/extensions/mcp/mcp-supervisor-engine.js"
export { DeterministicMediaResolver } from "./agents/extensions/media_source/deterministic-media-resolver.js"
export { MediaSourceSupervisor } from "./agents/extensions/media_source/media-source-supervisor.js"
export { ContinuousLearningCurator } from "./agents/extensions/memory/continuous-learning-curator.js"
export { MentionResolver } from "./agents/extensions/mentions/mention-resolver.js"
export { DeterministicNousPortalEngine } from "./agents/extensions/nous_portal/deterministic-nous-portal-engine.js"
export { NousPortalSupervisor } from "./agents/extensions/nous_portal/nous-portal-supervisor.js"
export { DeterministicOsvParser } from "./agents/extensions/osv/deterministic-osv-parser.js"
export { OsvScannerSupervisor } from "./agents/extensions/osv/osv-scanner-supervisor.js"
export { OtlpSupervisor } from "./agents/extensions/otlp/otlp-supervisor.js"
export { AtomicMutationSupervisor } from "./agents/extensions/patch/atomic-mutation-supervisor.js"
export { DeterministicPreflightScanner } from "./agents/extensions/preflight_scanner/deterministic-preflight-scanner.js"
export { PreflightScannerSupervisor } from "./agents/extensions/preflight_scanner/preflight-scanner-supervisor.js"
export { ProcessSupervisorEngine } from "./agents/extensions/process/process-supervisor-engine.js"
export { DeterministicProfileEngine } from "./agents/extensions/profiles/deterministic-profile-engine.js"
export { ProfileSupervisor } from "./agents/extensions/profiles/profile-supervisor.js"
export { PromptCacheSupervisor } from "./agents/extensions/prompt/prompt-cache-supervisor.js"
export { ReasoningSupervisor } from "./agents/extensions/reasoning/reasoning-supervisor.js"
export { SecretRedactionSupervisor } from "./agents/extensions/redaction/secret-redaction-supervisor.js"
export { AgentSlashRouter } from "./agents/extensions/resolution/agent-slash-router.js"
export type { AuthTokenRecord } from "./agents/extensions/resolution/auth-storage-vault.js"
export { AuthStorageVault } from "./agents/extensions/resolution/auth-storage-vault.js"
export type { CachedModelList } from "./agents/extensions/resolution/dynamic-model-cache.js"
export { DynamicModelCache } from "./agents/extensions/resolution/dynamic-model-cache.js"
export type { ProviderKeyStatus } from "./agents/extensions/resolution/environment-key-resolver.js"
export { EnvironmentKeyResolver } from "./agents/extensions/resolution/environment-key-resolver.js"
export type { DispatcherConfig } from "./agents/extensions/resolution/http-dispatcher.js"
export { HttpDispatcherOverlay } from "./agents/extensions/resolution/http-dispatcher.js"
export type { ImageModelSpecs } from "./agents/extensions/resolution/image-model-registry.js"
export { ImageModelRegistry } from "./agents/extensions/resolution/image-model-registry.js"
export type { ProxyEndpointConfig } from "./agents/extensions/resolution/llm-proxy-gateway.js"
export { LlmProxyGateway } from "./agents/extensions/resolution/llm-proxy-gateway.js"
export type { ModelSpecs } from "./agents/extensions/resolution/model-catalog.js"
export { ModelCatalog } from "./agents/extensions/resolution/model-catalog.js"
export { KNOWN_CODEX_MODELS, ModelResolver } from "./agents/extensions/resolution/model-resolver.js"
export type { AttributionRecord, AttributionSummary } from "./agents/extensions/resolution/provider-attribution.js"
export { ProviderAttributionComposer } from "./agents/extensions/resolution/provider-attribution.js"
export type { ReasoningEffortLevel } from "./agents/extensions/resolution/reasoning-effort-controller.js"
export { ReasoningEffortController } from "./agents/extensions/resolution/reasoning-effort-controller.js"
export { BackgroundReviewSupervisor } from "./agents/extensions/review/background-review-supervisor.js"
export { AuxiliaryRouterSupervisor } from "./agents/extensions/router/auxiliary-router-supervisor.js"
export { BroccoliRunbookSubstrate } from "./agents/extensions/runbooks/broccoli-runbook-substrate.js"
export { FilePredicateEvaluator } from "./agents/extensions/runbooks/file-predicate-evaluator.js"
export { MiniYamlError, MiniYamlParser } from "./agents/extensions/runbooks/mini-yaml-parser.js"
export { RunbookCatalog } from "./agents/extensions/runbooks/runbook-catalog.js"
export { RunbookHumanizer } from "./agents/extensions/runbooks/runbook-humanizer.js"
export { RunbookSupervisor, TransitionBlockedError } from "./agents/extensions/runbooks/runbook-supervisor.js"
export { DeterministicSchemaSanitizerEngine } from "./agents/extensions/schema_sanitizer/deterministic-schema-sanitizer-engine.js"
export { SchemaSanitizerSupervisor } from "./agents/extensions/schema_sanitizer/schema-sanitizer-supervisor.js"
export { DeterministicSelfRepoGuardEngine } from "./agents/extensions/self_repo_guard/deterministic-self-repo-guard-engine.js"
export { SelfRepoGuardSupervisor } from "./agents/extensions/self_repo_guard/self-repo-guard-supervisor.js"
export { DeterministicSkillLinterEngine } from "./agents/extensions/skill_linter/deterministic-skill-linter-engine.js"
export { SkillLinterSupervisor } from "./agents/extensions/skill_linter/skill-linter-supervisor.js"
export { AntiDegenerationGuard } from "./agents/extensions/skills/anti-degeneration-guard.js"
export { EvolutionarySkillTreeEngine } from "./agents/extensions/skills/evolutionary-skill-tree-engine.js"
export { SkillStrategyEngine } from "./agents/extensions/skills/skill-strategy-engine.js"
export { SkillTreePromptComposer } from "./agents/extensions/skills/skill-tree-prompt-composer.js"
export { DeterministicSkillsSyncClient } from "./agents/extensions/skills_sync/deterministic-skills-sync-client.js"
export { SkillsSyncSupervisor } from "./agents/extensions/skills_sync/skills-sync-supervisor.js"
export { SkillsHubSupervisor } from "./agents/extensions/skills-hub/skills-hub-supervisor.js"
export { TerminalSkinSupervisor } from "./agents/extensions/skin/terminal-skin-supervisor.js"
export { SoulPromptComposer } from "./agents/extensions/soul/soul-prompt-composer.js"
export { SoulThreatGuard } from "./agents/extensions/soul/soul-threat-guard.js"
export { DeterministicSpeechTextNormalizer } from "./agents/extensions/speech_normalizer/deterministic-speech-text-normalizer.js"
export { SpeechNormalizerSupervisor } from "./agents/extensions/speech_normalizer/speech-normalizer-supervisor.js"
export { DeterministicSpillVault } from "./agents/extensions/spill_vault/deterministic-spill-vault.js"
export { SpillVaultSupervisor } from "./agents/extensions/spill_vault/spill-vault-supervisor.js"
export { DeterministicStealthBrowser } from "./agents/extensions/stealth_browser/deterministic-stealth-browser.js"
export { StealthBrowserSupervisor } from "./agents/extensions/stealth_browser/stealth-browser-supervisor.js"
export { DeterministicStreamDiagEngine } from "./agents/extensions/stream_diag/deterministic-stream-diag-engine.js"
export { StreamDiagSupervisor } from "./agents/extensions/stream_diag/stream-diag-supervisor.js"
export { DeterministicStreamingScrubberEngine } from "./agents/extensions/streaming_scrubber/deterministic-streaming-scrubber-engine.js"
export { StreamingScrubberSupervisor } from "./agents/extensions/streaming_scrubber/streaming-scrubber-supervisor.js"
export { DeterministicSubdirHintEngine } from "./agents/extensions/subdir_hints/deterministic-subdir-hint-engine.js"
export { SubdirHintsSupervisor } from "./agents/extensions/subdir_hints/subdir-hints-supervisor.js"
export type { SwarmSubagentTaskResult } from "./agents/extensions/swarm/agent-swarm-dispatcher.js"
export { AgentSwarmDispatcher } from "./agents/extensions/swarm/agent-swarm-dispatcher.js"
export type { DagTaskNode, TaskStatus } from "./agents/extensions/swarm/broccoli-task-dag-scheduler.js"
export { BroccoliTaskDagScheduler } from "./agents/extensions/swarm/broccoli-task-dag-scheduler.js"
export type { MailboxMessage } from "./agents/extensions/swarm/broccolidb-inter-agent-mailbox.js"
export { BroccoliInterAgentMailbox } from "./agents/extensions/swarm/broccolidb-inter-agent-mailbox.js"
export type { ActiveWorkerRecord, TaskCoordinatorStatus } from "./agents/extensions/swarm/broccolidb-task-coordinator.js"
export { BroccoliTaskCoordinator } from "./agents/extensions/swarm/broccolidb-task-coordinator.js"
export type { AgentRefinement, ConflictResolution, ResolvedDecision } from "./agents/extensions/swarm/convergence-engine.js"
export { ConvergenceEngineSubstrate, PRIORITY_LATTICE } from "./agents/extensions/swarm/convergence-engine.js"
export { DeterministicTerminalCleanerEngine } from "./agents/extensions/terminal_cleaner/deterministic-terminal-cleaner-engine.js"
export { TerminalCleanerSupervisor } from "./agents/extensions/terminal_cleaner/terminal-cleaner-supervisor.js"
export { DeterministicThreadContextEngine } from "./agents/extensions/thread_context/deterministic-thread-context-engine.js"
export { ThreadContextSupervisor } from "./agents/extensions/thread_context/thread-context-supervisor.js"
export { ThreatFirewallSupervisor } from "./agents/extensions/threat/threat-firewall-supervisor.js"
export { ConversationInsightsEngine } from "./agents/extensions/title_insights/conversation-insights-engine.js"
export { DeterministicTitleGenerator } from "./agents/extensions/title_insights/deterministic-title-generator.js"
export { TitleInsightsSupervisor } from "./agents/extensions/title_insights/title-insights-supervisor.js"
export { DeterministicSpeechTranscriber } from "./agents/extensions/transcription/deterministic-speech-transcriber.js"
export { TranscriptionSupervisor } from "./agents/extensions/transcription/transcription-supervisor.js"
export { DeterministicTurnRetryEngine } from "./agents/extensions/turn_retry/deterministic-turn-retry-engine.js"
export { TurnRetrySupervisor } from "./agents/extensions/turn_retry/turn-retry-supervisor.js"
export { DeterministicUrlSafety } from "./agents/extensions/url_safety/deterministic-url-safety.js"
export { UrlSafetySupervisor } from "./agents/extensions/url_safety/url-safety-supervisor.js"
export { DeterministicV4aPatch } from "./agents/extensions/v4a_patch/deterministic-v4a-patch.js"
export { V4aPatchSupervisor } from "./agents/extensions/v4a_patch/v4a-patch-supervisor.js"
export { MultimodalVisionSupervisor } from "./agents/extensions/vision/multimodal-vision-supervisor.js"
export { VoiceSpeechSupervisor } from "./agents/extensions/voice/voice-speech-supervisor.js"
export { DeterministicWakeWord } from "./agents/extensions/wake_word/deterministic-wake-word.js"
export { WakeWordSupervisor } from "./agents/extensions/wake_word/wake-word-supervisor.js"
export { WalletSupervisor } from "./agents/extensions/wallet/wallet-supervisor.js"
export { WebIntelligenceSupervisor } from "./agents/extensions/web/web-intelligence-supervisor.js"
export { DeterministicWebsitePolicy } from "./agents/extensions/website_policy/deterministic-website-policy.js"
export { WebsitePolicySupervisor } from "./agents/extensions/website_policy/website-policy-supervisor.js"
export { DeterministicGitWorktree } from "./agents/extensions/worktree/deterministic-git-worktree.js"
export { WorktreeSupervisor } from "./agents/extensions/worktree/worktree-supervisor.js"
export { AbstractAgentEngine } from "./core/abstracts/abstract-agent-engine.js"
export { AbstractEars } from "./core/abstracts/abstract-ears.js"
export { AbstractHands } from "./core/abstracts/abstract-hands.js"
export { AbstractSessionStore } from "./core/abstracts/abstract-session-store.js"
export { AbstractToolRegistry } from "./core/abstracts/abstract-tool-registry.js"
export type {
	AcpApprovalStatus,
	AcpClientCapabilities,
	AcpClientToolCallRequest,
	AcpClientToolCallResult,
	AcpClientToolDefinition,
	AcpClientType,
	AcpDashboardViewMode,
	AcpDiagnosticItem,
	AcpDiagnosticSeverity,
	AcpDiffCard,
	AcpDiffHunk,
	AcpEditApprovalDecision,
	AcpEditApprovalRequest,
	AcpFileChange,
	AcpHunkLine,
	AcpHunkLineType,
	AcpHunkStatus,
	AcpMultiFileChangeset,
	AcpPermissionLevel,
	AcpRiskAssessment,
	AcpRiskLevel,
	AcpRollbackToken,
	AcpRpcNotification,
	AcpRpcRequest,
	AcpRpcResponse,
	AcpServerConfig,
	AcpSession,
	AcpSessionInfo,
	AcpSessionMode,
	AcpSpeculativeTransaction,
	AcpStagedFile,
	AcpStreamChunkNotification,
	AcpSubstrateSnapshot,
	AcpThoughtDeltaNotification,
	AcpToolExecutionNotification,
	AcpTransactionStatus,
	AcpTurnCompletionReport,
	AcpTurnStepNotification,
	AcpTurnStepRequest,
	AcpWorkspaceFolder,
	AcpWorkspaceFolderChangeEvent,
	IAcpBridgeServer,
	IAcpFineGrainedHunkPatcher,
	IAcpPermissionGate,
	IAcpProtocolCodec,
	IAcpSpeculativeChangesetStager,
	IBroccoliAcpSubstrate,
} from "./core/contracts/acp.contracts.js"
export type * from "./core/contracts/adversarial-scrutiny.contracts.js"
export type {
	EngineProgressEvent,
	EngineProgressMetadata,
	EngineProgressPhase,
	EngineProgressStatus,
	EngineTickInput,
	EngineTickOutcome,
	EngineTickResult,
	IAgentEngine,
	ProgressTelemetryMetrics,
} from "./core/contracts/agent.contracts.js"
export type {
	ApprovalActionType,
	ApprovalAuditEntry,
	ApprovalRiskLevel,
	ApprovalVerdict,
	ArbiterOptions,
	ArbiterSessionSnapshot,
	PendingApprovalRequest,
	RiskAssessmentResult,
	StagedWriteArtifact,
} from "./core/contracts/arbiter.contracts.js"
export type {
	AudioCacheEntry,
	AudioContainerDescriptor,
	AudioContainerId,
	AudioMimeType,
	AudioSniffResult,
	AudioWorkspaceSnapshot,
} from "./core/contracts/audio-container.contracts.js"
export {
	CONTAINER_TO_EXT,
	CONTAINER_TO_MIME,
	MP4_AUDIO_BRANDS,
} from "./core/contracts/audio-container.contracts.js"
export type {
	AuxiliaryDispatchAttempt,
	AuxiliaryProviderConfig,
	AuxiliaryRoutingRequest,
	AuxiliaryRoutingResult,
	AuxiliaryTaskType,
	AuxiliaryWorkspaceSnapshot,
} from "./core/contracts/auxiliary-router.contracts.js"
export type {
	BackgroundReviewBulkMutationResult,
	BackgroundReviewDslQueryFilter,
	BackgroundReviewGroupBy,
	BackgroundReviewGroupedLane,
	BackgroundReviewHealthAuditReport,
	BackgroundReviewHealthStatus,
	BackgroundReviewMetricsReport,
	BackgroundReviewMutationUndoRecord,
	BackgroundReviewSortBy,
	BackgroundReviewSortDirection,
	CandidateFactItem,
	CandidateFactRow,
	CandidateSkillItem,
	CandidateSkillRow,
	IBroccoliReviewSubstrate,
	ReviewAuditRow,
	ReviewTriggerPolicy,
	ReviewWorkspaceSnapshot,
	SessionInsightsBreakdown,
	SessionTitleSuggestion,
	TurnReviewDigest,
	TurnReviewResult,
	TurnReviewRow,
} from "./core/contracts/background-review.contracts.js"
export type {
	BatchAuditRow,
	BatchBenchmarkType,
	BatchBulkMutationResult,
	BatchDslQueryFilter,
	BatchExecutionConfig,
	BatchGroupBy,
	BatchGroupedLane,
	BatchHealthAuditReport,
	BatchHealthStatus,
	BatchMetricsReport,
	BatchMutationUndoRecord,
	BatchPriority,
	BatchResultRow,
	BatchRunMetrics,
	BatchRunRow,
	BatchRunState,
	BatchSortBy,
	BatchSortDirection,
	BatchTaskItem,
	BatchTaskResult,
	BatchTaskRow,
	BatchTaskStatus,
	BatchWorkspaceSnapshot,
	IBroccoliBatchSubstrate,
} from "./core/contracts/batch.contracts.js"
export type {
	AccountStatus,
	BillingAccountInfo,
	BillingAccountRow,
	BillingAuditRow,
	BillingBarStateRow,
	BillingTransaction,
	BillingTransactionRow,
	BillingUsageBulkMutationResult,
	BillingUsageConfig,
	BillingUsageDslQueryFilter,
	BillingUsageGroupBy,
	BillingUsageGroupedLane,
	BillingUsageHealthAuditReport,
	BillingUsageHealthStatus,
	BillingUsageMetrics,
	BillingUsageMetricsReport,
	BillingUsageMutationUndoRecord,
	BillingUsageSortBy,
	BillingUsageSortDirection,
	BillingUsageWorkspaceSnapshot,
	IBroccoliBillingUsageSubstrate,
	UsageBarDescriptor,
	UsageModelDescriptor,
} from "./core/contracts/billing-usage.contracts.js"
export {
	DEFAULT_BILLING_ACCOUNT_INFO,
	DEFAULT_BILLING_USAGE_CONFIG,
	DEFAULT_LOW_BALANCE_THRESHOLD_USD,
} from "./core/contracts/billing-usage.contracts.js"
export type {
	Bm25SearchResult,
	Broccoli2pcTransactionSession,
	Broccoli2pcTxState,
	BroccoliBlockSummary,
	BroccoliBufferPoolMetrics,
	BroccoliCachedPlan,
	BroccoliCdcCallback,
	BroccoliCdcEvent,
	BroccoliCdcFilter,
	BroccoliCdcOp,
	BroccoliCdcSubscription,
	BroccoliLeaseHandle,
	BroccoliLeaseMode,
	BroccoliLockHandle,
	BroccoliLockMode,
	BroccoliLsmCompactionStats,
	BroccoliMvccTransaction,
	BroccoliPageFrame,
	BroccoliPlanCacheMetrics,
	BroccoliPoolMetrics,
	BroccoliQueryPlan,
	BroccoliQueryPlanType,
	BroccoliRaftAppendEntriesRequest,
	BroccoliRaftAppendEntriesResponse,
	BroccoliRaftLogEntry,
	BroccoliRaftNodeRole,
	BroccoliRaftVoteRequest,
	BroccoliRaftVoteResponse,
	BroccoliRecordVersion,
	BroccoliSagaExecutionResult,
	BroccoliSagaState,
	BroccoliSagaStep,
	BroccoliSagaStepStatus,
	BroccoliSparseIndexScanResult,
	BroccoliSsTableMeta,
	BroccoliTieredCacheEntry,
	BroccoliTieredCacheMetrics,
	BroccoliVectorAggType,
	BroccoliVectorChunk,
	BroccoliVectorFilterOp,
	BTreeNodeEntry,
	CasBlobDescriptor,
	CasStorageStats,
	DbDurabilityMode,
	DbHealthReport,
	DbQueryOptions,
	DeadlockDetectionResult,
	DeadlockEdge,
	HashRingNode,
	IBroccoli2pcParticipant,
	IBroccoliAdaptivePlanCache,
	IBroccoliBTreeIndexEngine,
	IBroccoliBufferPoolManager,
	IBroccoliCdcStream,
	IBroccoliConnectionPool,
	IBroccoliConsistentHashRing,
	IBroccoliDatabaseKernel,
	IBroccoliDeadlockDetector,
	IBroccoliInvertedIndexEngine,
	IBroccoliLockAuthority,
	IBroccoliLsmStore,
	IBroccoliMaterializedViewEngine,
	IBroccoliMvccEngine,
	IBroccoliQueryOptimizer,
	IBroccoliRaftConsensusEngine,
	IBroccoliSagaOrchestrator,
	IBroccoliSparseIndexEngine,
	IBroccoliTieredKvCache,
	IBroccoliTimeSeriesRollupEngine,
	IBroccoliTwoPhaseCommitCoordinator,
	IBroccoliVectorAnnEngine,
	IBroccoliVectorEngine,
	IDbTable,
	MaterializedViewAggregateFunc,
	MaterializedViewDefinition,
	MaterializedViewRow,
	TermPostingList,
	TimelineCheckpointRecord,
	TimeSeriesPoint,
	TimeSeriesWindowAggregation,
	VectorAnnSearchResult,
	VectorDistanceMetric,
	WalFrame,
	WalOperationType,
} from "./core/contracts/broccolidb.contracts.js"
export type * from "./core/contracts/broccolidb-runbook.contracts.js"
export type {
	CdpBrowserStateSnapshot,
	CdpConsoleMessage,
	CdpDialogEvent,
	CdpDialogPolicy,
	CdpDialogStatus,
	CdpDialogType,
	CdpDomNode,
	CdpDomSnapshot,
	CdpNavigationPolicy,
	CdpNetworkRequest,
	CdpTarget,
	CdpTargetType,
	IBroccoliBrowserSubstrate,
	IBrowserSnapshotManager,
	ICdpProtocolClient,
	ICdpSupervisor,
} from "./core/contracts/cdp.contracts.js"
export type {
	BloomFilterManifest,
	CasBlob,
	CasChunk,
	CasChunkManifest,
	CasDeltaCompressionStats,
	CasDeltaPatch,
	CasPackfileManifest,
	CheckpointAuditRow,
	CheckpointBisectResult,
	CheckpointBisectState,
	CheckpointBlameLine,
	CheckpointBlameReport,
	CheckpointBlobRow,
	CheckpointBranchRef,
	CheckpointBulkMutationResult,
	CheckpointCherryPickResult,
	CheckpointChunkRow,
	CheckpointConflictManifest,
	CheckpointConflictMarker,
	CheckpointDiffResult,
	CheckpointDslQueryFilter,
	CheckpointGroupBy,
	CheckpointGroupedLane,
	CheckpointHealthAuditReport,
	CheckpointHealthStatus,
	CheckpointMergeResult,
	CheckpointMetricsReport,
	CheckpointMutationUndoRecord,
	CheckpointNode,
	CheckpointNodeRow,
	CheckpointOpLogEntry,
	CheckpointOpLogRow,
	CheckpointOpLogType,
	CheckpointRebaseResult,
	CheckpointRefRow,
	CheckpointRevertResult,
	CheckpointRollbackResult,
	CheckpointSignatureManifest,
	CheckpointSortBy,
	CheckpointSortDirection,
	CheckpointSquashResult,
	CheckpointStagingFile,
	CheckpointTagRef,
	CheckpointTreeRow,
	CheckpointWorkingTreeStatus,
	CheckpointWorkspaceSnapshot,
	GitBundleManifest,
	GitBundlePayload,
	IBroccoliCheckpointSubstrate,
	TreeEntry,
} from "./core/contracts/checkpoint.contracts.js"
export type {
	ClarifyAuditRow,
	ClarifyAutoPolicy,
	ClarifyBulkMutationResult,
	ClarifyCategory,
	ClarifyChoice,
	ClarifyDecisionNode,
	ClarifyDecisionTree,
	ClarifyDslQueryFilter,
	ClarifyGroupBy,
	ClarifyGroupedLane,
	ClarifyHealthAuditReport,
	ClarifyHealthStatus,
	ClarifyInputMode,
	ClarifyInquiry,
	ClarifyInquiryRow,
	ClarifyMetricsReport,
	ClarifyMutationUndoRecord,
	ClarifyPriority,
	ClarifyResolution,
	ClarifyResolutionRow,
	ClarifySortBy,
	ClarifySortDirection,
	ClarifyStatus,
	ClarifyWorkspaceSnapshot,
	IBroccoliClarifySubstrate,
} from "./core/contracts/clarify.contracts.js"
export type {
	CompressedTurnSummary,
	CompressionAuditRow,
	CompressionBulkMutationResult,
	CompressionDslQueryFilter,
	CompressionGroupBy,
	CompressionGroupedLane,
	CompressionHealthAuditReport,
	CompressionHealthStatus,
	CompressionMetricsReport,
	CompressionMutationUndoRecord,
	CompressionPolicy,
	CompressionSortBy,
	CompressionSortDirection,
	CompressionStateSnapshot,
	CompressionSummaryRow,
	IBroccoliCompressionSubstrate,
	ICompressionSnapshotManager,
	IDeterministicToolPruner,
	IHeadTailBudgetGovernor,
	ITrajectoryCompactorEngine,
	PrunedToolOutputRow,
	TokenWindowBudget,
	ToolPruningPolicy,
} from "./core/contracts/compression.contracts.js"
export type {
	ComputerActionResult,
	ComputerActionRow,
	ComputerActionType,
	ComputerUseBulkMutationResult,
	ComputerUseDslQueryFilter,
	ComputerUseGroupBy,
	ComputerUseGroupedLane,
	ComputerUseHealthAuditReport,
	ComputerUseHealthStatus,
	ComputerUseMetricsReport,
	ComputerUseMutationUndoRecord,
	ComputerUseSortBy,
	ComputerUseSortDirection,
	ComputerWorkspaceSnapshot,
	DisplayAuditRow,
	IBroccoliDisplaySubstrate,
	UiElement,
	UiElementBounds,
	UiElementRole,
	UiElementRow,
	VirtualDisplayFrame,
	VirtualWindow,
} from "./core/contracts/computer-use.contracts.js"
export type {
	ContextBreakdownConfig,
	ContextBreakdownMetrics,
	ContextBreakdownReport,
	ContextBreakdownWorkspaceSnapshot,
	ContextCategoryId,
	ContextCategorySlice,
} from "./core/contracts/context-breakdown.contracts.js"
export { DEFAULT_CONTEXT_BREAKDOWN_CONFIG } from "./core/contracts/context-breakdown.contracts.js"
export type {
	BudgetCapConfig,
	CostAuditRow,
	CostBudgetRow,
	CostBulkMutationResult,
	CostDslQueryFilter,
	CostGovernanceResult,
	CostGovernanceWorkspaceSnapshot,
	CostGroupBy,
	CostGroupedLane,
	CostHealthAuditReport,
	CostHealthStatus,
	CostLedgerRow,
	CostMetricsReport,
	CostMutationUndoRecord,
	CostPricingTierRow,
	CostSortBy,
	CostSortDirection,
	IBroccoliCostSubstrate,
	ModelPricingTier,
	TokenUsageLedgerEntry,
} from "./core/contracts/cost-governance.contracts.js"
export type {
	CredentialAccount,
	CredentialRotationStrategy,
	CredentialStateSnapshot,
	CredentialStatus,
	IBroccoliCredentialSubstrate,
	ICredentialPool,
	ICredentialSnapshotManager,
	TokenBucketState,
} from "./core/contracts/credential.contracts.js"
export type {
	AutomationBlueprint,
	BlueprintSlot,
	BlueprintSlotType,
	CronBlueprintRow,
	CronBulkMutationResult,
	CronDslQueryFilter,
	CronExecutionRecord,
	CronExecutionRow,
	CronGroupBy,
	CronGroupedLane,
	CronHealthAuditReport,
	CronHealthStatus,
	CronJobManifest,
	CronJobRow,
	CronJobStatus,
	CronMetricsReport,
	CronMutationUndoRecord,
	CronNotificationEvent,
	CronNotificationPreferences,
	CronNotificationRecord,
	CronNotificationRow,
	CronNotificationTrigger,
	CronNotificationUrgency,
	CronQueryFilter,
	CronScheduleType,
	CronSortBy,
	CronSortDirection,
	CronStateSnapshot,
	IBroccoliCronSubstrate,
	ICronScheduler,
	ICronSnapshotManager,
} from "./core/contracts/cron.contracts.js"
export type {
	DaemonHealthMatrix,
	DaemonHealthProbe,
	DaemonLogEntry,
	DaemonProcess,
	DaemonProcessDashboardCard,
	DaemonStatus,
	DaemonSubstrateSnapshot,
	DaemonSupervisorConfig,
	DaemonWatchdogPolicy,
} from "./core/contracts/daemon.contracts.js"
export type {
	BoundedResult,
	DeadlineAuditRow,
	DeadlineBulkMutationResult,
	DeadlineConfig,
	DeadlineDslQueryFilter,
	DeadlineEstopRow,
	DeadlineGroupBy,
	DeadlineGroupedLane,
	DeadlineHealthAuditReport,
	DeadlineHealthStatus,
	DeadlineLease,
	DeadlineLeaseRow,
	DeadlineLeaseStatus,
	DeadlineMetrics,
	DeadlineMetricsReport,
	DeadlineMutationUndoRecord,
	DeadlineOutcome,
	DeadlineSortBy,
	DeadlineSortDirection,
	DeadlineTimeoutRow,
	DeadlineWorkspaceSnapshot,
	EstopState,
	IBroccoliDeadlineSubstrate,
} from "./core/contracts/deadline.contracts.js"
export {
	DEFAULT_DEADLINE_CONFIG,
	MAX_SAFE_TIMEOUT_MS,
} from "./core/contracts/deadline.contracts.js"
export type {
	BatchDelegationResult,
	DelegationOutcome,
	IBroccoliSwarmSubstrate,
	ISubagentBudgetGovernor,
	ISubagentVfsBrancher,
	ISwarmDelegator,
	ISwarmSnapshotManager,
	IWorktreeManager,
	SubagentBudget,
	SwarmBulkMutationResult,
	SwarmDslQueryFilter,
	SwarmGroupBy,
	SwarmGroupedLane,
	SwarmHealthAuditReport,
	SwarmHealthStatus,
	SwarmMetricsReport,
	SwarmMutationUndoRecord,
	SwarmNotificationEvent,
	SwarmNotificationPreferences,
	SwarmNotificationRecord,
	SwarmNotificationRow,
	SwarmNotificationTrigger,
	SwarmNotificationUrgency,
	SwarmOutcomeRow,
	SwarmSortBy,
	SwarmSortDirection,
	SwarmStateSnapshot,
	SwarmTaskManifest,
	SwarmTaskRow,
	SwarmTaskStatus,
	SwarmWorktreeRow,
	WorktreeIsolationSpec,
} from "./core/contracts/delegation.contracts.js"
export type {
	DiagnosticCheckCategory,
	DiagnosticCheckResult,
	DiagnosticCheckRow,
	DiagnosticDoctorBulkMutationResult,
	DiagnosticDoctorDslQueryFilter,
	DiagnosticDoctorGroupBy,
	DiagnosticDoctorGroupedLane,
	DiagnosticDoctorHealthAuditReport,
	DiagnosticDoctorHealthStatus,
	DiagnosticDoctorMetricsReport,
	DiagnosticDoctorMutationUndoRecord,
	DiagnosticDoctorSortBy,
	DiagnosticDoctorSortDirection,
	DiagnosticReportRow,
	DiagnosticSeverity,
	DoctorAuditRow,
	DoctorWorkspaceSnapshot,
	IBroccoliDoctorSubstrate,
	OrphanedTurnRepairItem,
	SessionSalvageReport,
	SessionSalvageRow,
	SystemDiagnosticReport,
} from "./core/contracts/diagnostic-doctor.contracts.js"
export type {
	BinaryCategory,
	CachedExtractedDoc,
	DocExtractorMetrics,
	DocExtractorWorkspaceSnapshot,
	DocumentExtractionOptions,
	DocumentExtractionResult,
	DocumentFormat,
	OpaqueWriteCheckResult,
} from "./core/contracts/doc-extractor.contracts.js"
export {
	BINARY_EXTENSIONS,
	EXTRACTABLE_EXTENSIONS,
	OPAQUE_DOCUMENT_EXTENSIONS,
} from "./core/contracts/doc-extractor.contracts.js"
export type {
	DataLossPreventionFinding,
	EmailAddress,
	EmailBulkMutationResult,
	EmailDisposition,
	EmailDraft,
	EmailDraftRow,
	EmailDslQueryFilter,
	EmailGroupBy,
	EmailGroupedLane,
	EmailHealthAuditReport,
	EmailHealthStatus,
	EmailMessage,
	EmailMessageRow,
	EmailMetricsReport,
	EmailMutationUndoRecord,
	EmailNotificationEvent,
	EmailNotificationPreferences,
	EmailNotificationRecord,
	EmailNotificationRow,
	EmailNotificationTrigger,
	EmailNotificationUrgency,
	EmailReminderRow,
	EmailSkillConfig,
	EmailSortBy,
	EmailSortDirection,
	EmailSubstrateSnapshot,
	EmailThreatAlert,
	EmailThreatAnalysis,
	EmailTonePersona,
	EmailTriageReport,
	EmailTriageRow,
	FollowUpReminder,
	IBroccoliEmailSubstrate,
	MeetingScheduleIntent,
	OutboundDlpReport,
	QuickReplyOption,
	SenderAuthSecurityStatus,
	SmartReplySuggestions,
	ThreadActionItem,
	ThreadCollisionLock,
	ThreadSummaryAnalysis,
	VipContactRule,
} from "./core/contracts/email.contracts.js"
export type {
	EnvProbeConfig,
	EnvProbeMetrics,
	EnvProbeWorkspaceSnapshot,
	ToolchainAnomalyCategory,
	ToolchainProbeDescriptor,
	ToolchainRuntimeKind,
} from "./core/contracts/env-probe.contracts.js"
export { DEFAULT_ENV_PROBE_CONFIG } from "./core/contracts/env-probe.contracts.js"
export type {
	EnvironmentSessionState,
	EnvironmentStateSnapshot,
	ExecutionBackendType,
	ExecutionCommandResult,
	ExecutionCommandSpec,
	IBroccoliEnvironmentSubstrate,
	IEnvironmentSnapshotManager,
	IEnvironmentSupervisorEngine,
	IExecutionEnvironmentAdapter,
	ISecretScrubber,
	SecurityIsolationProfile,
} from "./core/contracts/environment.contracts.js"
export type {
	CodeExecutionLanguage,
	CodeExecutionResult,
	ExecutionAuditRow,
	ExecutionBulkMutationResult,
	ExecutionDslQueryFilter,
	ExecutionGroupBy,
	ExecutionGroupedLane,
	ExecutionHealthAuditReport,
	ExecutionHealthStatus,
	ExecutionMetricsReport,
	ExecutionMutationUndoRecord,
	ExecutionRecord,
	ExecutionRecordRow,
	ExecutionSortBy,
	ExecutionSortDirection,
	ExecutionStatus,
	ExecutionWorkspaceSnapshot,
	IBroccoliExecutionSubstrate,
	ProgrammaticToolCall,
	SandboxContext,
	SandboxSecurityPolicy,
	ToolCallRow,
} from "./core/contracts/execution.contracts.js"
export type {
	BackoffPolicySpec,
	ClassifiedFault,
	FaultCategory,
	FaultTaxonomyStateSnapshot,
	IBroccoliFaultSubstrate,
	IDeterministicErrorClassifier,
	IFaultRecoverySupervisor,
	IFaultSnapshotManager,
	IJitteredBackoffGovernor,
	JitterMode,
	ProviderHealthRecord,
	RecoveryDirectiveType,
} from "./core/contracts/fault.contracts.js"
export type {
	FileSafetyEvaluation,
	FileSafetyMetrics,
	FileSafetyPolicyConfig,
	FileSafetyVerdict,
	FileSafetyWorkspaceSnapshot,
} from "./core/contracts/file-safety.contracts.js"
export { DEFAULT_FILE_SAFETY_CONFIG } from "./core/contracts/file-safety.contracts.js"
export type {
	CandidateMatchScore,
	CandidateRankingResult,
	ClosestLineCandidate,
	CodemodPipelineResult,
	CodemodRule,
	CodemodRuleType,
	CodemodStepResult,
	ConditionalInversionOptions,
	ConditionalInversionResult,
	ConflictBlockAnalysis,
	ConflictMarkerChunk,
	ConflictResolutionResult,
	ConflictResolutionStrategy,
	ContextWindow,
	DocSyncOptions,
	DocSyncResult,
	EscapeDriftDetection,
	FunctionExtractOptions,
	FunctionInlineOptions,
	FunctionRefactorOptions,
	FunctionRefactorResult,
	FunctionSignatureParam,
	FuzzyExecutionRecord,
	FuzzyMatcherOptions,
	FuzzyMatchResult,
	FuzzyMatchSpan,
	FuzzyMultiMatchResult,
	FuzzyReplacementHunk,
	FuzzyStrategyName,
	FuzzyWorkspaceSnapshot,
	HistogramDiffHunk,
	HistogramDiffOptions,
	HistogramDiffResult,
	ImpactedSymbol,
	ImportAliasResolutionOptions,
	ImportAliasResolutionResult,
	ImportOptimizationOptions,
	ImportOptimizationResult,
	ImportSpecifierItem,
	ImportStatementAnalysis,
	IndentationHarmonizationResult,
	IndentationStyle,
	InversePatchHunk,
	InversePatchResult,
	LexicalToken,
	LexicalTokenType,
	LspApplyResult,
	LspTextEdit,
	LspWorkspaceEdit,
	MergeResolutionCandidate,
	MismatchDiagnosis,
	MultiCursorEditSpan,
	MultiCursorParallelResult,
	MultiFileInversePatchResult,
	MultiFilePatchResult,
	MultiFileTransactionHunk,
	MultiFileTransactionResult,
	MultiRegionSkeletonOptions,
	MultiRegionSkeletonResult,
	MultiSourceHunkInput,
	MultiSourcePatchSynthesisResult,
	MultiSourceSynthesizedPatch,
	NGramMatchCandidate,
	NGramSimilarityOptions,
	NGramSimilarityResult,
	NullabilityGuardOptions,
	NullabilityGuardResult,
	PatchBranchCandidate,
	PatchBranchEvaluation,
	PatchBranchExploreResult,
	PatchDriftHunkResult,
	PatchDriftOptions,
	PatchDriftResult,
	PatienceDiffHunk,
	PatienceDiffOptions,
	PatienceDiffResult,
	PruneUnusedOptions,
	PruneUnusedResult,
	RecordedConflictEntry,
	RecordedConflictPreimage,
	RelocateCodeBlockOptions,
	RelocateCodeBlockResult,
	RelocateMutation,
	RerereReplayResult,
	ScopeBoundedMatchOptions,
	ScopeBoundedMatchResult,
	SearchReplaceBlock,
	SemanticConflictExplanation,
	SemanticTreeApplyResult,
	SemanticTreeDiffOptions,
	SemanticTreeDiffResult,
	SemanticTreeNode,
	SemanticTreeNodeType,
	SemanticTreeOp,
	SemanticTreeOpType,
	SignatureRefactorOptions,
	SignatureRefactorResult,
	SkeletonRegionMatch,
	StructuralHoleBinding,
	StructuralPatternMatchItem,
	StructuralPatternMatchResult,
	StructuralPatternOptions,
	StructuredConfigFormat,
	StructuredConfigPatchOptions,
	StructuredConfigPatchResult,
	SymbolRenameFileResult,
	SymbolRenameOccurrence,
	SymbolRenameOptions,
	SyntaxBalanceIssue,
	SyntaxBoundarySnapResult,
	SyntaxRepairResult,
	ThreeWayMergeConflictResolution,
	ThreeWayMergeHunk,
	ThreeWayMergeOptions,
	ThreeWayMergeResult,
	TokenStreamMatchOptions,
	TokenStreamMatchResult,
	UnifiedPatchHunk,
	UnifiedPatchResult,
	WordDiffHighlight,
	WorkspaceFilePatch,
	WorkspacePatchImpactResult,
	WorkspaceSymbolRenameResult,
} from "./core/contracts/fuzzy-matcher.contracts.js"
export type {
	ChannelBindingRule,
	ContactVipTier,
	DeliveryReceipt,
	GatewayActionButton,
	GatewayActionButtonStyle,
	GatewayAttachment,
	GatewayBallotOption,
	GatewayChannelSession,
	GatewayDeliveryStatus,
	GatewayFilterPill,
	GatewayHandoverMode,
	GatewayHealthMatrix,
	GatewayInlineBallot,
	GatewayInlineDataTable,
	GatewayInlineMenuItem,
	GatewayInlineMenuNode,
	GatewayInlineTab,
	GatewayInlineTabGroup,
	GatewayInlineWizard,
	GatewayInPlaceMutationResult,
	GatewayInteractiveCard,
	GatewayMediaCard,
	GatewayMediaType,
	GatewayMessage,
	GatewayMessageDirection,
	GatewayMessageEnvelope,
	GatewayMessageFormat,
	GatewayOutboundPayload,
	GatewayPlatform,
	GatewayPlatformType,
	GatewayReaction,
	GatewaySessionLease,
	GatewaySkillConfig,
	GatewaySlaPolicy,
	GatewayStateSnapshot,
	GatewaySubstrateSnapshot,
	GatewayThreadTriage,
	GatewayTypingState,
	GatewayUserIdentity,
	GatewayUserRole,
	GatewayWhisperNote,
	GatewayWizardStep,
	IGatewayDeliveryLedger,
	IGatewayDispatcher,
	IGatewayPlatformAdapter,
	LinkedPlatformIdentity,
	PlatformHealthStatus,
	SlashCommandRoute,
	UnifiedContactProfile,
	WebhookVerificationRequest,
	WebhookVerificationResult,
} from "./core/contracts/gateway.contracts.js"
export type {
	GoalArchiveResult,
	GoalBulkMutationResult,
	GoalBurnupDataPoint,
	GoalBurnupForecast,
	GoalCategory,
	GoalCloneOptions,
	GoalContract,
	GoalDecompositionResult,
	GoalDiffResult,
	GoalDslQueryFilter,
	GoalEvaluationResult,
	GoalExportFormat,
	GoalGate,
	GoalGatePolicy,
	GoalGroupBy,
	GoalGroupedLane,
	GoalHealthAuditReport,
	GoalHealthStatus,
	GoalHierarchyReport,
	GoalMilestone,
	GoalMilestoneChecklistItem,
	GoalMilestoneRollbackResult,
	GoalMutationUndoRecord,
	GoalNotificationEvent,
	GoalNotificationPreferences,
	GoalNotificationRecord,
	GoalNotificationTrigger,
	GoalNotificationUrgency,
	GoalQueryFilter,
	GoalRetroSummary,
	GoalRiskDiagnosis,
	GoalSortBy,
	GoalSortDirection,
	GoalState,
	GoalStateSnapshot,
	GoalStatus,
	GoalStepEvent,
	GoalSwarmBalanceResult,
	GoalSwarmHandoffResult,
	GoalTemplate,
	GoalVelocityMetrics,
	GoalVerdict,
	GoalWatchdogReport,
	MilestoneStatus,
} from "./core/contracts/goal.contracts.js"
export {
	DEFAULT_GATE_MAX_RETRIES,
	DEFAULT_GATE_TIMEOUT_SECONDS,
	DEFAULT_GOAL_JUDGE_TIMEOUT_MS,
	DEFAULT_GOAL_MAX_TURNS,
	GATE_OUTPUT_TAIL_CHARS,
} from "./core/contracts/goal.contracts.js"
export type {
	CommandRiskLevel,
	CommandSafetyClassification,
	HeredocAuditRow,
	HeredocBodySpan,
	HeredocDiagnosticRow,
	HeredocInterpreterType,
	HeredocOperatorSpec,
	HeredocSanitizationLogRecord,
	HeredocSanitizationResult,
	HeredocSanitizationRow,
	HeredocTerminalBulkMutationResult,
	HeredocTerminalConfig,
	HeredocTerminalDslQueryFilter,
	HeredocTerminalGroupBy,
	HeredocTerminalGroupedLane,
	HeredocTerminalHealthAuditReport,
	HeredocTerminalHealthStatus,
	HeredocTerminalMetricsReport,
	HeredocTerminalMutationUndoRecord,
	HeredocTerminalSortBy,
	HeredocTerminalSortDirection,
	HeredocTerminalWorkspaceSnapshot,
	IBroccoliHeredocTerminalSubstrate,
	ScriptHeredocOptions,
	ScriptHeredocResult,
	TerminalDiagnosticCategory,
	TerminalDiagnosticHint,
	TerminalExecutionDiagnostics,
} from "./core/contracts/heredoc-terminal.contracts.js"
export {
	DANGEROUS_SHELL_PATTERNS,
	DEFAULT_HEREDOC_TERMINAL_CONFIG,
	INERT_HEREDOC_CONSUMER_PATTERN,
} from "./core/contracts/heredoc-terminal.contracts.js"
export type {
	AuthAuditRow,
	AuthFlowType,
	AuthProviderId,
	AuthWorkspaceSnapshot,
	DeviceAuthorizationPending,
	DeviceAuthRow,
	IBroccoliAuthSubstrate,
	IdentityFederationBulkMutationResult,
	IdentityFederationDslQueryFilter,
	IdentityFederationGroupBy,
	IdentityFederationGroupedLane,
	IdentityFederationHealthAuditReport,
	IdentityFederationHealthStatus,
	IdentityFederationMetricsReport,
	IdentityFederationMutationUndoRecord,
	IdentityFederationSortBy,
	IdentityFederationSortDirection,
	PkceChallengePair,
	SubscriptionEntitlement,
	SubscriptionTier,
	SubscriptionTierRow,
	TokenLeaseRecord,
	TokenLeaseRow,
} from "./core/contracts/identity-federation.contracts.js"
export type {
	AlertLevel,
	CustomerPaymentStatus,
	IBroccoliIntegrationsSubstrate,
	IntegrationAuditLog,
	IntegrationAuditLogRow,
	IntegrationAuthType,
	IntegrationCategory,
	IntegrationConnection,
	IntegrationConnectionRow,
	IntegrationProviderType,
	IntegrationRecipe,
	IntegrationRecipeRow,
	IntegrationsBulkMutationResult,
	IntegrationsDslQueryFilter,
	IntegrationsGroupBy,
	IntegrationsGroupedLane,
	IntegrationsHealthAuditReport,
	IntegrationsHealthMatrix,
	IntegrationsHealthStatus,
	IntegrationsMetricsReport,
	IntegrationsMutationUndoRecord,
	IntegrationsSkillConfig,
	IntegrationsSortBy,
	IntegrationsSortDirection,
	IntegrationsSubstrateSnapshot,
	IssuePriority,
	IssueStatus,
	PlatformIntegrationHealth,
	ServiceCatalogEntry,
	UnifiedAlert,
	UnifiedCustomer,
	UnifiedDocument,
	UnifiedIssue,
	UnifiedIssueRow,
	WorkflowExecutionResult,
	WorkflowStep,
} from "./core/contracts/integrations.contracts.js"
export type {
	KanbanBoard,
	KanbanBulkMutationResult,
	KanbanColumn,
	KanbanDeadlinesReport,
	KanbanExportFormat,
	KanbanGroupBy,
	KanbanGroupedSwimlane,
	KanbanMutationUndoRecord,
	KanbanNotificationEvent,
	KanbanNotificationPreferences,
	KanbanNotificationRecord,
	KanbanNotificationTrigger,
	KanbanNotificationUrgency,
	KanbanPriority,
	KanbanQueryFilter,
	KanbanSortBy,
	KanbanSortDirection,
	KanbanSubtaskChecklistItem,
	KanbanTask,
	KanbanTaskHierarchy,
	KanbanTaskMutation,
	KanbanVelocityMetrics,
	KanbanWorkloadBalanceResult,
	KanbanWorkspaceSnapshot,
} from "./core/contracts/kanban.contracts.js"
export type {
	DiscoveredLocalModel,
	LocalContextTuningProfile,
	LocalEmbeddingResult,
	LocalEndpointAuditReport,
	LocalEndpointMetricsReport,
	LocalEndpointProfile,
	LocalFailoverRoute,
	LocalHardwareAssessment,
	LocalInferenceBenchmarkResult,
	LocalModelUnloadResult,
	LocalProviderKind,
	LocalQuickstartGuide,
	LocalServerHealthStatus,
	ModelPullPhase,
	ModelPullProgress,
	ModelVramCompatibility,
	ProcessSpawnResult,
	VramCompatibilityTier,
} from "./core/contracts/local-endpoints.contracts.js"
export type {
	LspDefinition,
	LspDiagnostic,
	LspDiagnosticRelatedInformation,
	LspDiagnosticSeverity,
	LspDocumentState,
	LspHoverInfo,
	LspPosition,
	LspQueryOptions,
	LspRange,
	LspReferenceLocation,
	LspSymbolInformation,
	LspSymbolKind,
	LspWorkspaceSnapshot,
} from "./core/contracts/lsp.contracts.js"
export type {
	McpPromptArgument,
	McpPromptDefinition,
	McpResourceDefinition,
	McpSamplingRequest,
	McpSamplingResponse,
	McpServerConfig,
	McpServerState,
	McpServerStatus,
	McpSessionSnapshot,
	McpToolCallRequest,
	McpToolCallResponse,
	McpToolDefinition,
	McpToolParameterSchema,
	McpTransportType,
} from "./core/contracts/mcp-client.contracts.js"
export type {
	MediaKind,
	MediaSourceConfig,
	MediaSourceMetrics,
	MediaSourceOrigin,
	MediaSourceWorkspaceSnapshot,
	ResolvedMedia,
} from "./core/contracts/media-source.contracts.js"
export { DEFAULT_MEDIA_SOURCE_CONFIG } from "./core/contracts/media-source.contracts.js"
export type {
	CuratorKnowledgeEdge,
	CuratorKnowledgeNode,
	CuratorOptions,
	CuratorReviewDirective,
	IBroccoliLearningSubstrate,
	KnowledgeGraphSnapshot,
	KnowledgeNodeType,
	MemoryAuditRow,
	MemoryBulkMutationResult,
	MemoryDslQueryFilter,
	MemoryEdgeRow,
	MemoryGroupBy,
	MemoryGroupedLane,
	MemoryHealthAuditReport,
	MemoryHealthStatus,
	MemoryMetricsReport,
	MemoryMutationUndoRecord,
	MemoryNodeRow,
	MemoryQueryOptions,
	MemoryRecallResult,
	MemoryRecallRow,
	MemorySortBy,
	MemorySortDirection,
} from "./core/contracts/memory-curator.contracts.js"
export type {
	NousAccountInfoSource,
	NousPaidServiceAccessInfo,
	NousPortalAccountInfo,
	NousPortalCompletionResponse,
	NousPortalDeviceCodeSession,
	NousPortalDynamicModelItem,
	NousPortalModelSpec,
	NousPortalModelsFetchOptions,
	NousPortalModelsFetchResult,
	NousPortalRequestPayload,
	NousPortalStateSnapshot,
	NousPortalSubscriptionInfo,
	NousPortalTokenResponse,
	NousToolAccessInfo,
	NousToolCoverageCategory,
} from "./core/contracts/nous-portal.contracts.js"
export {
	DEFAULT_NOUS_CLIENT_ID,
	DEFAULT_NOUS_INFERENCE_URL,
	DEFAULT_NOUS_PORTAL_URL,
	DEFAULT_NOUS_SCOPE,
	NOUS_BILLING_MANAGE_SCOPE,
	NOUS_INFERENCE_INVOKE_SCOPE,
	NOUS_TOOL_COVERAGE_CATEGORIES,
} from "./core/contracts/nous-portal.contracts.js"
export type {
	IBroccoliOsvSubstrate,
	OsvAdvisory,
	OsvAuditRow,
	OsvBulkMutationResult,
	OsvCachedEntry,
	OsvDslQueryFilter,
	OsvGroupBy,
	OsvGroupedLane,
	OsvHealthAuditReport,
	OsvHealthStatus,
	OsvMetricsReport,
	OsvMutationUndoRecord,
	OsvScannerConfig,
	OsvScannerMetrics,
	OsvScannerWorkspaceSnapshot,
	OsvScanResult,
	OsvScanResultRow,
	OsvSortBy,
	OsvSortDirection,
	PackageEcosystem,
	ParsedPackageTarget,
} from "./core/contracts/osv-scanner.contracts.js"
export { DEFAULT_OSV_SCANNER_CONFIG } from "./core/contracts/osv-scanner.contracts.js"
export type {
	OtlpBottleneckReport,
	OtlpExporterConfig,
	OtlpFlameGraphSegment,
	OtlpHealthMatrix,
	OtlpSpan,
	OtlpSubstrateSnapshot,
	OtlpTracePayload,
	SpanEvent,
	SpanKind,
	SpanLink,
	SpanStatusCode,
	W3CTraceContext,
} from "./core/contracts/otlp.contracts.js"
export type {
	FileMutationEntry,
	FileMutationRow,
	FileMutationSnapshot,
	FilePaginatedReadResult,
	FilePaginationOptions,
	IBroccoliPatchSubstrate,
	PatchApplyResult,
	PatchAuditRow,
	PatchBulkMutationResult,
	PatchHunk,
	PatchHunkLine,
	PatchMutationDslQueryFilter,
	PatchMutationGroupBy,
	PatchMutationGroupedLane,
	PatchMutationHealthAuditReport,
	PatchMutationHealthStatus,
	PatchMutationMetricsReport,
	PatchMutationSortBy,
	PatchMutationSortDirection,
	PatchMutationUndoRecord,
	PatchOperation,
	PatchOperationRow,
	PatchOperationType,
} from "./core/contracts/patch-mutation.contracts.js"
export type {
	IBroccoliPreflightSubstrate,
	PreflightAuditRow,
	PreflightBulkMutationResult,
	PreflightDslQueryFilter,
	PreflightGroupBy,
	PreflightGroupedLane,
	PreflightHealthAuditReport,
	PreflightHealthStatus,
	PreflightMetrics,
	PreflightMetricsReport,
	PreflightMutationUndoRecord,
	PreflightScanResult,
	PreflightScanResultRow,
	PreflightSecurityPolicy,
	PreflightSortBy,
	PreflightSortDirection,
	PreflightThreatCategory,
	PreflightThreatFinding,
	PreflightThreatSeverity,
	PreflightVerdict,
	PreflightWorkspaceSnapshot,
	SupplyChainVerificationResult,
} from "./core/contracts/preflight-scanner.contracts.js"
export { DEFAULT_PREFLIGHT_SECURITY_POLICY } from "./core/contracts/preflight-scanner.contracts.js"
export type {
	ProcessExecutionStatus,
	ProcessHandleDescriptor,
	ProcessPollResult,
	ProcessSessionSnapshot,
	ProcessSpawnOptions,
	ProcessWatchMatch,
	ProcessWatchPattern,
} from "./core/contracts/process.contracts.js"
export type {
	ContentModerationTier,
	FallbackTrigger,
	IBroccoliProfileSubstrate,
	KnowledgeSourceKind,
	MemoryEvictionStrategy,
	ProfileAuditRow,
	ProfileAxiomComplianceReport,
	ProfileBindingRow,
	ProfileBlueprint,
	ProfileBulkMutationResult,
	ProfileCategory,
	ProfileCloneKind,
	ProfileCloneOptions,
	ProfileConversationStarter,
	ProfileDelegationConfig,
	ProfileDelegationStrategy,
	ProfileDescriptor,
	ProfileDiffResult,
	ProfileDslQueryFilter,
	ProfileEvalAssertion,
	ProfileEvalReport,
	ProfileExecutionParameters,
	ProfileExemplar,
	ProfileExportBundle,
	ProfileGovernanceConfig,
	ProfileGroupBy,
	ProfileGroupedLane,
	ProfileGuardrailConfig,
	ProfileHealthAuditReport,
	ProfileHealthStatus,
	ProfileKnowledgeSource,
	ProfileLifecycleEvent,
	ProfileLifecycleEventPayload,
	ProfileLifecycleHook,
	ProfileMcpBinding,
	ProfileMemoryPolicy,
	ProfileMetricsReport,
	ProfileModelFallback,
	ProfileMutation,
	ProfileMutationUndoRecord,
	ProfilePrefixCacheFrame,
	ProfileQueryFilter,
	ProfileReasoningEffort,
	ProfileResponseFormat,
	ProfileRevision,
	ProfileRevisionRow,
	ProfileRow,
	ProfileRunState,
	ProfileRunStatus,
	ProfileRunStep,
	ProfileSecretBinding,
	ProfileSortBy,
	ProfileSortDirection,
	ProfileStatus,
	ProfileTelemetry,
	ProfileTemplateHydrationContext,
	ProfileTestCase,
	ProfileTestCaseResult,
	ProfileTransitionRow,
	ProfileVariant,
	ProfileVoiceConfig,
	ProfileWorkspaceSnapshot,
} from "./core/contracts/profile.contracts.js"
export { PROFILE_ID_REGEX } from "./core/contracts/profile.contracts.js"
export type {
	ByteStablePromptEnvelope,
	CacheBreakpointType,
	IBroccoliPromptCacheSubstrate,
	PromptCacheAuditRow,
	PromptCacheBreakpoint,
	PromptCacheBreakpointRow,
	PromptCacheBulkMutationResult,
	PromptCacheConfig,
	PromptCacheDslQueryFilter,
	PromptCacheGroupBy,
	PromptCacheGroupedLane,
	PromptCacheHealthAuditReport,
	PromptCacheHealthStatus,
	PromptCacheMarker,
	PromptCacheMetrics,
	PromptCacheMetricsReport,
	PromptCacheMutationUndoRecord,
	PromptCacheSortBy,
	PromptCacheSortDirection,
	PromptCacheWorkspaceSnapshot,
	ReasoningSanitizationResult,
} from "./core/contracts/prompt-cache.contracts.js"
export { DEFAULT_PROMPT_CACHE_CONFIG } from "./core/contracts/prompt-cache.contracts.js"
export type {
	ReasoningBlock,
	ReasoningScrubberOptions,
	ReasoningTagPair,
	ReasoningTimeoutConfig,
	ReasoningWorkspaceSnapshot,
	ScrubbedStreamChunk,
} from "./core/contracts/reasoning.contracts.js"
export type * from "./core/contracts/runbook.contracts.js"
export type {
	IBroccoliSchemaSanitizerSubstrate,
	SchemaSanitizationEventRow,
	SchemaSanitizationResult,
	SchemaSanitizerAuditRow,
	SchemaSanitizerBulkMutationResult,
	SchemaSanitizerConfig,
	SchemaSanitizerDslQueryFilter,
	SchemaSanitizerGroupBy,
	SchemaSanitizerGroupedLane,
	SchemaSanitizerHealthAuditReport,
	SchemaSanitizerHealthStatus,
	SchemaSanitizerMetrics,
	SchemaSanitizerMetricsReport,
	SchemaSanitizerMutationUndoRecord,
	SchemaSanitizerSortBy,
	SchemaSanitizerSortDirection,
	SchemaSanitizerWorkspaceSnapshot,
} from "./core/contracts/schema-sanitizer.contracts.js"
export {
	DEFAULT_SCHEMA_SANITIZER_CONFIG,
	FORBIDDEN_REF_SIBLING_KEYWORDS,
	PROPERTY_KEY_INVALID_CHARS_REGEX,
	PROPERTY_KEY_REGEX,
	TOP_LEVEL_FORBIDDEN_COMBINATORS,
} from "./core/contracts/schema-sanitizer.contracts.js"
export type {
	IBroccoliSearchSubstrate,
	IDeterministicSessionSearchEngine,
	IFtsQuerySanitizer,
	IndexedMessageRecord,
	ISearchSnapshotManager,
	SearchIndexSnapshot,
	SearchMatchSnippet,
	SearchQueryOptions,
} from "./core/contracts/search.contracts.js"
export type {
	PathSafetyDecision,
	RedactionCategory,
	RedactionMatch,
	RedactionResult,
	SecretRedactionWorkspaceSnapshot,
} from "./core/contracts/secret-redaction.contracts.js"
export type {
	GitOperationSafety,
	IBroccoliSelfRepoGuardSubstrate,
	SelfRepoGuardAuditRow,
	SelfRepoGuardBulkMutationResult,
	SelfRepoGuardConfig,
	SelfRepoGuardDslQueryFilter,
	SelfRepoGuardGroupBy,
	SelfRepoGuardGroupedLane,
	SelfRepoGuardHealthAuditReport,
	SelfRepoGuardHealthStatus,
	SelfRepoGuardIncident,
	SelfRepoGuardIncidentRow,
	SelfRepoGuardMetrics,
	SelfRepoGuardMetricsReport,
	SelfRepoGuardMutationUndoRecord,
	SelfRepoGuardSortBy,
	SelfRepoGuardSortDirection,
	SelfRepoGuardVerdict,
	SelfRepoGuardWorkspaceSnapshot,
} from "./core/contracts/self-repo-guard.contracts.js"
export {
	DEFAULT_SELF_REPO_GUARD_CONFIG,
	RESET_WORKTREE_MODES,
	SAFE_GIT_BUILTINS,
	STASH_SAFE_ACTIONS,
	WORKTREE_MUTATING_GIT_COMMANDS,
	WORKTREE_TARGET_ACTIONS,
} from "./core/contracts/self-repo-guard.contracts.js"
export type { GameStateSnapshot, ISessionStore, SessionMessage, SlabBufferSnapshot } from "./core/contracts/session.contracts.js"
export type {
	ArchiveAuditRow,
	ArchiveManifestRow,
	ArchiveWorkspaceSnapshot,
	ExportedDocumentResult,
	ExportedDocumentRow,
	ExportedTurnItem,
	ExportOptions,
	IBroccoliArchiveSubstrate,
	SessionArchiveBulkMutationResult,
	SessionArchiveDslQueryFilter,
	SessionArchiveGroupBy,
	SessionArchiveGroupedLane,
	SessionArchiveHealthAuditReport,
	SessionArchiveHealthStatus,
	SessionArchiveManifest,
	SessionArchiveMetricsReport,
	SessionArchiveMutationUndoRecord,
	SessionArchiveSortBy,
	SessionArchiveSortDirection,
	SessionExportFormat,
} from "./core/contracts/session-archive.contracts.js"
export type {
	IBroccoliSkillLinterSubstrate,
	SkillLintAuditRow,
	SkillLinterBulkMutationResult,
	SkillLinterConfig,
	SkillLinterDslQueryFilter,
	SkillLinterGroupBy,
	SkillLinterGroupedLane,
	SkillLinterHealthAuditReport,
	SkillLinterHealthStatus,
	SkillLinterMetrics,
	SkillLinterMetricsReport,
	SkillLinterMutationUndoRecord,
	SkillLinterSortBy,
	SkillLinterSortDirection,
	SkillLinterWorkspaceSnapshot,
	SkillLintFinding,
	SkillLintFindingRow,
	SkillLintReport,
	SkillLintReportRow,
	SkillLintRuleCode,
	SkillLintSeverity,
} from "./core/contracts/skill-linter.contracts.js"
export {
	DEFAULT_SKILL_LINTER_CONFIG,
	FORBIDDEN_SCAFFOLDING_FILES,
	MARKETING_BUZZWORDS,
	SHELL_UTIL_TO_TOOL_MAP,
} from "./core/contracts/skill-linter.contracts.js"
export type {
	IAnchoredSkillMutator,
	IAntiDegenerationGuard,
	IBroccoliSkillTreeSubstrate,
	IDeterministicSkillCurator,
	IEvolutionarySkillEngine,
	ISkillStrategyEngine,
	ISkillTreeParser,
	ISkillTreeSnapshotManager,
	SkillAutoRemediationReport,
	SkillBulkMutationResult,
	SkillComboSynergy,
	SkillCompetencyUncertainty,
	SkillCompetencyVector,
	SkillCriticalPath,
	SkillCustomTweakSpec,
	SkillDirectorySyncReport,
	SkillDroppedFileEntry,
	SkillDropVaultStatus,
	SkillDslQueryFilter,
	SkillEvolutionLineage,
	SkillEvolutionMilestone,
	SkillEvolutionPath,
	SkillEvolutionSignal,
	SkillExecutionPolicy,
	SkillForgeOptions,
	SkillFormatExportKind,
	SkillGroupBy,
	SkillGroupedLane,
	SkillHealthAuditReport,
	SkillHealthStatus,
	SkillImportResult,
	SkillLifecycleState,
	SkillMetricsReport,
	SkillMutationChunk,
	SkillMutationPayload,
	SkillMutationResult,
	SkillMutationRow,
	SkillMutationUndoRecord,
	SkillNodeLintIssue,
	SkillNodeLintReport,
	SkillNodeLintSeverity,
	SkillNodeManifest,
	SkillNodeRow,
	SkillNotificationEvent,
	SkillNotificationPreferences,
	SkillNotificationRow,
	SkillNotificationTrigger,
	SkillNotificationUrgency,
	SkillPowerUpPack,
	SkillProgressionTrack,
	SkillProvenance,
	SkillPruningRecommendation,
	SkillRecommendation,
	SkillSnapshotDiffResult,
	SkillSortBy,
	SkillSortDirection,
	SkillSpeciationEvaluation,
	SkillStateSnapshot,
	SkillStrategyGoal,
	SkillStrategyPlan,
	SkillStrategyStep,
	SkillSupportFile,
	SkillTier,
	SkillTransactionContext,
	SkillTreeDag,
	SkillUsageRow,
	SkillWizardAnswers,
	SkillWizardOption,
	SkillWizardQuestion,
	SpecializedBranch,
} from "./core/contracts/skills.contracts.js"
export type {
	SkillInstallationResult,
	SkillPackage,
	SkillRegistryManifest,
	SkillsHubWorkspaceSnapshot,
} from "./core/contracts/skills-hub.contracts.js"
export type {
	ConflictResolutionChoice,
	SkillProvenanceState,
	SkillSyncCommit,
	SkillSyncManifest,
	SkillSyncManifestEntry,
	SkillSyncObject,
	SkillSyncProvenanceReport,
	SkillSyncPullResult,
	SkillSyncPushResult,
	SkillSyncTree,
	SkillSyncTreeEntry,
	SkillSyncWorkspaceSnapshot,
	SkillThreeWayMergeConflict,
	SkillThreeWayMergeResult,
	SyncObjectKind,
	TreeEntryMode,
} from "./core/contracts/skills-sync.contracts.js"
export {
	DEFAULT_MAX_SYNC_OBJECT_BYTES,
	SYNC_WIRE_VERSION,
} from "./core/contracts/skills-sync.contracts.js"
export type {
	IBroccoliSoulSubstrate,
	SoulArchetype,
	SoulAuditTrailEntry,
	SoulAxiom,
	SoulAxiomRow,
	SoulBookmark,
	SoulBulkMutationResult,
	SoulCustomTweakSpec,
	SoulDiffEntry,
	SoulDiffReport,
	SoulDirectorySyncReport,
	SoulDroppedFileEntry,
	SoulDropVaultStatus,
	SoulDslQueryFilter,
	SoulForgeOptions,
	SoulFormatExportKind,
	SoulFuzzyMatchSuggestion,
	SoulGroupBy,
	SoulGroupedLane,
	SoulHealthAuditReport,
	SoulHealthStatus,
	SoulImportResult,
	SoulLintSeverity,
	SoulManifest,
	SoulManifestRow,
	SoulMetricsReport,
	SoulMutationIntent,
	SoulMutationResult,
	SoulMutationRow,
	SoulMutationUndoRecord,
	SoulPersonaLintIssue,
	SoulPersonaLintReport,
	SoulPersonalityPack,
	SoulPresetBundle,
	SoulPresetCategory,
	SoulRiskSeverity,
	SoulSnapshot,
	SoulSortBy,
	SoulSortDirection,
	SoulStyleRules,
	SoulTaxonomyNode,
	SoulTaxonomyTraitInfo,
	SoulThreatScanDetailed,
	SoulTrait,
	SoulTraitRow,
	SoulWizardAnswers,
	SoulWizardOption,
	SoulWizardQuestion,
} from "./core/contracts/soul.contracts.js"
export type {
	LexiconCategory,
	SpeechLexiconEntry,
	SpeechNormalizationOptions,
	SpeechNormalizationResult,
	SpeechWorkspaceSnapshot,
} from "./core/contracts/speech-normalizer.contracts.js"
export type {
	PersistedResultDescriptor,
	SpillPrivacyTier,
	SpillVaultMetrics,
	SpillVaultWorkspaceSnapshot,
	TurnBudgetConfig,
	TurnBudgetEnforcementResult,
} from "./core/contracts/spill-vault.contracts.js"
export {
	DEFAULT_MAX_RESULT_CHARS,
	DEFAULT_MAX_TURN_BUDGET_CHARS,
	DEFAULT_PREVIEW_HEAD,
	DEFAULT_PREVIEW_TAIL,
	PERSISTED_OUTPUT_CLOSING_TAG,
	PERSISTED_OUTPUT_TAG,
} from "./core/contracts/spill-vault.contracts.js"
export type {
	AccessibilityRefNode,
	AccessibilitySnapshot,
	CookieRecord,
	RefInteractionAction,
	RefInteractionResult,
	StealthBrowserLogRecord,
	StealthBrowserTab,
	StealthBrowserViewport,
	StealthBrowserWorkspaceSnapshot,
	StealthFingerprintProfile,
	StorageEntry,
	StorageType,
	UrlRewriteResult,
} from "./core/contracts/stealth-browser.contracts.js"
export {
	DEFAULT_VIEWPORT,
	DOCKER_INTERNAL_HOST,
	LOOPBACK_HOSTS,
} from "./core/contracts/stealth-browser.contracts.js"
export type {
	StreamDiagConfig,
	StreamDiagMetrics,
	StreamDiagnosticAttempt,
	StreamDiagWorkspaceSnapshot,
	StreamDropEvent,
} from "./core/contracts/stream-diag.contracts.js"
export {
	DEFAULT_STREAM_DIAG_CONFIG,
	STREAM_DIAG_DEFAULT_HEADERS,
} from "./core/contracts/stream-diag.contracts.js"
export type {
	IBroccoliStreamingScrubberSubstrate,
	ReasoningTagName,
	StreamingScrubberAuditRow,
	StreamingScrubberBulkMutationResult,
	StreamingScrubberDslQueryFilter,
	StreamingScrubberEventRow,
	StreamingScrubberGroupBy,
	StreamingScrubberGroupedLane,
	StreamingScrubberHealthAuditReport,
	StreamingScrubberHealthStatus,
	StreamingScrubberMetricsReport,
	StreamingScrubberMutationUndoRecord,
	StreamingScrubberSortBy,
	StreamingScrubberSortDirection,
	StreamingScrubberState,
	StreamingScrubResult,
	StreamingThinkScrubberConfig,
	StreamingThinkScrubberMetrics,
	StreamingThinkScrubberWorkspaceSnapshot,
} from "./core/contracts/streaming-think-scrubber.contracts.js"
export {
	DEFAULT_REASONING_TAG_NAMES,
	DEFAULT_STREAMING_THINK_SCRUBBER_CONFIG,
} from "./core/contracts/streaming-think-scrubber.contracts.js"
export type {
	DiscoveredSubdirHint,
	IBroccoliSubdirectoryHintsSubstrate,
	SubdirectoryHintAuditRow,
	SubdirectoryHintRow,
	SubdirectoryHintsBulkMutationResult,
	SubdirectoryHintsConfig,
	SubdirectoryHintsDslQueryFilter,
	SubdirectoryHintsGroupBy,
	SubdirectoryHintsGroupedLane,
	SubdirectoryHintsHealthAuditReport,
	SubdirectoryHintsHealthStatus,
	SubdirectoryHintsMetrics,
	SubdirectoryHintsMetricsReport,
	SubdirectoryHintsMutationUndoRecord,
	SubdirectoryHintsSortBy,
	SubdirectoryHintsSortDirection,
	SubdirectoryHintsWorkspaceSnapshot,
	SubdirHintDiscoveryResult,
} from "./core/contracts/subdirectory-hints.contracts.js"
export { DEFAULT_SUBDIRECTORY_HINTS_CONFIG } from "./core/contracts/subdirectory-hints.contracts.js"
export type {
	AnsiCleanMode,
	BinaryAssetClassification,
	IBroccoliTerminalCleanerSubstrate,
	TerminalCleanEventRow,
	TerminalCleanerAuditRow,
	TerminalCleanerBulkMutationResult,
	TerminalCleanerConfig,
	TerminalCleanerDslQueryFilter,
	TerminalCleanerGroupBy,
	TerminalCleanerGroupedLane,
	TerminalCleanerHealthAuditReport,
	TerminalCleanerHealthStatus,
	TerminalCleanerMetrics,
	TerminalCleanerMetricsReport,
	TerminalCleanerMutationUndoRecord,
	TerminalCleanerSortBy,
	TerminalCleanerSortDirection,
	TerminalCleanerWorkspaceSnapshot,
	TerminalCleanResult,
} from "./core/contracts/terminal-cleaner.contracts.js"
export {
	DEFAULT_TERMINAL_CLEANER_CONFIG,
	TERMINAL_KNOWN_BINARY_EXTENSIONS,
	TERMINAL_OPAQUE_DOCUMENT_EXTENSIONS,
} from "./core/contracts/terminal-cleaner.contracts.js"
export type {
	BannerRenderOptions,
	SkinBranding,
	SkinPalette,
	SkinWorkspaceSnapshot,
	SpinnerConfig,
	TerminalSkinPreset,
} from "./core/contracts/terminal-skin.contracts.js"
export type {
	AsyncTurnContextDescriptor,
	ContextAuditRow,
	ContextPropagationConfig,
	ContextPropagationMetrics,
	ExecutionDispatchEvent,
	ExecutionDispatchRow,
	IBroccoliThreadContextSubstrate,
	SecurityApprovalCallback,
	SudoPasswordCallback,
	ThreadContextBulkMutationResult,
	ThreadContextDslQueryFilter,
	ThreadContextGroupBy,
	ThreadContextGroupedLane,
	ThreadContextHealthAuditReport,
	ThreadContextHealthStatus,
	ThreadContextMetricsReport,
	ThreadContextMutationUndoRecord,
	ThreadContextRow,
	ThreadContextSortBy,
	ThreadContextSortDirection,
	ThreadContextWorkspaceSnapshot,
} from "./core/contracts/thread-context.contracts.js"
export { DEFAULT_CONTEXT_PROPAGATION_CONFIG } from "./core/contracts/thread-context.contracts.js"
export type {
	ThreatBypassMode,
	ThreatCategory,
	ThreatFinding,
	ThreatPolicyConfig,
	ThreatScanResult,
	ThreatSeverity,
	ThreatTrustLevel,
	ThreatWorkspaceSnapshot,
} from "./core/contracts/threat.contracts.js"
export type {
	ActivityTrendMetric,
	ConversationInsightsReport,
	IBroccoliTitleInsightsSubstrate,
	InsightDateRange,
	InsightSummaryRow,
	ModelUsageMetric,
	PlatformUsageMetric,
	SessionActivityEvent,
	SessionActivityEventRow,
	SessionInsightsOverview,
	SessionTitleProvenance,
	SessionTitleRecord,
	SessionTitleRow,
	SessionTokenEconomics,
	SkillUsageMetric,
	TitleAuditRow,
	TitleGenerationOptions,
	TitleGenerationResult,
	TitleInsightsBulkMutationResult,
	TitleInsightsDslQueryFilter,
	TitleInsightsGroupBy,
	TitleInsightsGroupedLane,
	TitleInsightsHealthAuditReport,
	TitleInsightsHealthStatus,
	TitleInsightsMetricsReport,
	TitleInsightsMutationUndoRecord,
	TitleInsightsSortBy,
	TitleInsightsSortDirection,
	TitleInsightsWorkspaceSnapshot,
	ToolUsageMetric,
	TopSessionMetric,
} from "./core/contracts/title-insights.contracts.js"
export {
	CONTROL_WRAPPERS,
	MACHINE_PREFIXES,
	MAX_DERIVED_TITLE_CHARS,
	MAX_MODEL_TITLE_CHARS,
	MAX_TITLE_INPUT_CHARS,
} from "./core/contracts/title-insights.contracts.js"
export type {
	DeferredToolDefinition,
	DeferredToolRow,
	DisclosureManifest,
	DisclosureTier,
	IBroccoliToolDisclosureSubstrate,
	ToolDisclosureAuditRow,
	ToolDisclosureBulkMutationResult,
	ToolDisclosureConfig,
	ToolDisclosureDslQueryFilter,
	ToolDisclosureGroupBy,
	ToolDisclosureGroupedLane,
	ToolDisclosureHealthAuditReport,
	ToolDisclosureHealthStatus,
	ToolDisclosureMetrics,
	ToolDisclosureMetricsReport,
	ToolDisclosureMutationUndoRecord,
	ToolDisclosureSortBy,
	ToolDisclosureSortDirection,
	ToolDisclosureWorkspaceSnapshot,
	ToolSearchResult,
} from "./core/contracts/tool-disclosure.contracts.js"
export { DEFAULT_TOOL_DISCLOSURE_CONFIG } from "./core/contracts/tool-disclosure.contracts.js"
export type {
	IBroccoliExecutionGuardSubstrate,
	LoopGuardrailDecision,
	ToolCallItem,
	ToolExecutionAuditRow,
	ToolExecutionBatchSegment,
	ToolExecutionGuardBulkMutationResult,
	ToolExecutionGuardConfig,
	ToolExecutionGuardDslQueryFilter,
	ToolExecutionGuardGroupBy,
	ToolExecutionGuardGroupedLane,
	ToolExecutionGuardHealthAuditReport,
	ToolExecutionGuardHealthStatus,
	ToolExecutionGuardMetrics,
	ToolExecutionGuardMetricsReport,
	ToolExecutionGuardMutationUndoRecord,
	ToolExecutionGuardSortBy,
	ToolExecutionGuardSortDirection,
	ToolExecutionMode,
	ToolExecutionSegmentRow,
	ToolExecutionWorkspaceSnapshot,
	ToolLoopViolationRecord,
	ToolLoopViolationRow,
} from "./core/contracts/tool-execution-segment.contracts.js"
export { DEFAULT_TOOL_EXECUTION_GUARD_CONFIG } from "./core/contracts/tool-execution-segment.contracts.js"
export type {
	AnchoredEditResult,
	CommandResult,
	ExecutionAuthorityConfig,
	ExecutionAuthorityLevel,
	IEars,
	IHands,
	IToolRegistry,
	JsonRpcNotification,
	PipelinedStreamChunk,
	ResourceConflictAssessment,
	TerminalProgressFrame,
	ToolExecutionOptions,
	ToolingEvent,
} from "./core/contracts/tooling.contracts.js"
export type {
	AudioTranscriptionResult,
	CachedTranscriptRecord,
	TranscriptionConfig,
	TranscriptionMetrics,
	TranscriptionProvider,
	TranscriptionSegment,
	TranscriptionWorkspaceSnapshot,
	WordTimestamp,
} from "./core/contracts/transcription.contracts.js"
export { DEFAULT_TRANSCRIPTION_CONFIG } from "./core/contracts/transcription.contracts.js"
export type {
	IBroccoliTurnRetrySubstrate,
	TurnRecoveryBranch,
	TurnRestartSignalKey,
	TurnRestartSignals,
	TurnRetryAttemptRecord,
	TurnRetryAttemptRow,
	TurnRetryAuditRow,
	TurnRetryBulkMutationResult,
	TurnRetryConfig,
	TurnRetryDslQueryFilter,
	TurnRetryErrorCategory,
	TurnRetryGroupBy,
	TurnRetryGroupedLane,
	TurnRetryGuards,
	TurnRetryHealthAuditReport,
	TurnRetryHealthStatus,
	TurnRetryHistoryEntry,
	TurnRetryMetrics,
	TurnRetryMetricsReport,
	TurnRetryMutationUndoRecord,
	TurnRetrySortBy,
	TurnRetrySortDirection,
	TurnRetryStateDescriptor,
	TurnRetryStateRow,
	TurnRetryWorkspaceSnapshot,
} from "./core/contracts/turn-retry.contracts.js"
export {
	DEFAULT_TURN_RESTART_SIGNALS,
	DEFAULT_TURN_RETRY_CONFIG,
	DEFAULT_TURN_RETRY_GUARDS,
} from "./core/contracts/turn-retry.contracts.js"
export type {
	IBroccoliUrlSafetySubstrate,
	IpAddressCategory,
	UrlSafetyAuditRow,
	UrlSafetyBulkMutationResult,
	UrlSafetyCheckResult,
	UrlSafetyCheckRow,
	UrlSafetyConfig,
	UrlSafetyDslQueryFilter,
	UrlSafetyGroupBy,
	UrlSafetyGroupedLane,
	UrlSafetyHealthAuditReport,
	UrlSafetyHealthStatus,
	UrlSafetyMetrics,
	UrlSafetyMetricsReport,
	UrlSafetyMutationUndoRecord,
	UrlSafetySortBy,
	UrlSafetySortDirection,
	UrlSafetyVerdict,
	UrlSafetyWorkspaceSnapshot,
} from "./core/contracts/url-safety.contracts.js"
export {
	CLOUD_METADATA_HOSTS,
	CLOUD_METADATA_IPS,
	DEFAULT_URL_SAFETY_CONFIG,
} from "./core/contracts/url-safety.contracts.js"
export type {
	V4aApplyResult,
	V4aHunk,
	V4aHunkLine,
	V4aOperationType,
	V4aPatchMetrics,
	V4aPatchOperation,
	V4aPatchParseResult,
	V4aPatchWorkspaceSnapshot,
	WorkingDiffMode,
	WorkingDiffResult,
} from "./core/contracts/v4a-patch.contracts.js"
export type {
	EvidenceAuditRow,
	EvidenceKind,
	EvidenceScope,
	IBroccoliEvidenceSubstrate,
	SessionInsightsReport,
	VerificationEvidenceBulkMutationResult,
	VerificationEvidenceDslQueryFilter,
	VerificationEvidenceGroupBy,
	VerificationEvidenceGroupedLane,
	VerificationEvidenceHealthAuditReport,
	VerificationEvidenceHealthStatus,
	VerificationEvidenceMetricsReport,
	VerificationEvidenceMutationUndoRecord,
	VerificationEvidenceRecord,
	VerificationEvidenceRow,
	VerificationEvidenceSortBy,
	VerificationEvidenceSortDirection,
	VerificationEvidenceWorkspaceSnapshot,
	VerificationStopGateEvaluation,
} from "./core/contracts/verification-evidence.contracts.js"
export type {
	ImageDimensions,
	ImageFormat,
	ImageGenerationRequest,
	ImageGenerationResult,
	ImageMetadata,
	VisionSessionState,
	VisionWorkspaceSnapshot,
	VisualInspectionResult,
} from "./core/contracts/vision.contracts.js"
export type {
	AudioChunk,
	AudioFormat,
	AudioSampleRate,
	SpeechSynthesisResult,
	TranscriptionResult,
	TranscriptionWord,
	VadDecision,
	VoiceProfile,
	VoiceProvider,
	VoiceSessionState,
	VoiceWorkspaceSnapshot,
} from "./core/contracts/voice.contracts.js"
export type {
	WakeWordConfig,
	WakeWordEngineProvider,
	WakeWordFrameResult,
	WakeWordMetrics,
	WakeWordState,
	WakeWordWorkspaceSnapshot,
} from "./core/contracts/wake-word.contracts.js"
export { DEFAULT_WAKE_WORD_CONFIG } from "./core/contracts/wake-word.contracts.js"
export type {
	AccountAbstractionSimulationResult,
	AddressBookContact,
	AssetDelta,
	BridgeQuoteRequest,
	BridgeQuoteResult,
	ContractInspectionResult,
	DeFiHealthReport,
	DeFiPosition,
	EIP712SignatureAuditRequest,
	EIP712SignatureAuditResult,
	GasMarketReport,
	GasTierEstimate,
	IBroccoliWalletSubstrate,
	MultiSigTransactionStage,
	SecurityRiskTier,
	SupportedChain,
	SwapQuoteRequest,
	SwapQuoteResult,
	SwapRouteHop,
	TokenAllowanceRecord,
	TokenAllowanceRow,
	TokenHolding,
	TransactionSimulationRequest,
	TransactionSimulationResult,
	UserOperationRequest,
	WalletAuditRow,
	WalletBulkMutationResult,
	WalletDslQueryFilter,
	WalletGroupBy,
	WalletGroupedLane,
	WalletHealthAuditReport,
	WalletHealthStatus,
	WalletMetricsReport,
	WalletMutationUndoRecord,
	WalletPortfolio,
	WalletPortfolioRow,
	WalletSimulationRow,
	WalletSkillConfig,
	WalletSortBy,
	WalletSortDirection,
	WalletSubstrateSnapshot,
	YieldOptimizationReport,
	YieldStakingPosition,
} from "./core/contracts/wallet.contracts.js"
export type {
	UrlSecurityVerdict,
	WebContentExtraction,
	WebExtractionFormat,
	WebSearchHit,
	WebSearchResult,
	WebSessionState,
	WebWorkspaceSnapshot,
} from "./core/contracts/web.contracts.js"
export type {
	WebsiteAccessCheckResult,
	WebsitePolicyConfig,
	WebsitePolicyMetrics,
	WebsitePolicyRule,
	WebsitePolicySource,
	WebsitePolicyWorkspaceSnapshot,
} from "./core/contracts/website-policy.contracts.js"
export { DEFAULT_WEBSITE_POLICY_CONFIG } from "./core/contracts/website-policy.contracts.js"
export type {
	WorktreeConfig,
	WorktreeDescriptor,
	WorktreeMetrics,
	WorktreeStatus,
	WorktreeWorkspaceSnapshot,
} from "./core/contracts/worktree.contracts.js"
export { DEFAULT_WORKTREE_CONFIG } from "./core/contracts/worktree.contracts.js"
export {
	type AgentProviderId,
	CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL,
	CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS,
	CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
	getAgentProviderLabel,
	isClaudeSubscriptionDirectSdkModel,
	normalizeAgentProvider,
	normalizeClaudeSubscriptionDirectSdkModel,
	OPENAI_CODEX_PROVIDER,
} from "./core/providers/provider-ids.js"
export {
	estimateMessagesTokens,
	estimateMessageTokens,
	estimateTextTokens,
	truncateTextToTokenBudget,
} from "./core/utilities/token-estimator.js"
export type { CompositionVerification } from "./factories/grand-monolith-synthesizer.js"
export {
	CURRENT_EVOLUTION_BASELINE,
	CURRENT_REQUIRED_COMPONENTS,
	GrandMonolithSynthesizer,
} from "./factories/grand-monolith-synthesizer.js"
export { MonolithFactory } from "./factories/monolith-factory.js"
export {
	CLAUDE_SUBSCRIPTION_DIRECTSDK_PLUGIN_ENV,
	CLAUDE_SUBSCRIPTION_DIRECTSDK_PYTHON_ENV,
	CLAUDE_SUBSCRIPTION_DIRECTSDK_TIMEOUT_ENV,
	ClaudeSubscriptionDirectSdkError,
	createClaudeSubscriptionDirectSdkCompletion,
	createClaudeToolNameMapping,
	discoverClaudeSubscriptionDirectSdkModels,
	diagnoseClaudeSubscriptionDirectSdk,
	resolveClaudeSubscriptionDirectSdkPluginDir,
} from "./integrations/claude-subscription-directsdk/provider.js"
export { SessionContext } from "./sessions/base/session-context.js"
export { AcpFineGrainedHunkPatcher } from "./sessions/extensions/acp/acp-fine-grained-hunk-patcher.js"
export { AcpSnapshotManager } from "./sessions/extensions/acp/acp-snapshot-manager.js"
export { AcpSpeculativeChangesetStager } from "./sessions/extensions/acp/acp-speculative-changeset-stager.js"
export { BroccoliAcpSubstrate } from "./sessions/extensions/acp/broccoli-acp-substrate.js"
export { BroccoliAdversarialSubstrate } from "./sessions/extensions/adversarial/broccoli-adversarial-substrate.js"
export { ArbiterSnapshotManager } from "./sessions/extensions/arbiter/arbiter-snapshot-manager.js"
export { BroccoliArbiterSubstrate } from "./sessions/extensions/arbiter/broccoli-arbiter-substrate.js"
export { ArchiveSnapshotManager } from "./sessions/extensions/archive/archive-snapshot-manager.js"
export { BroccoliArchiveSubstrate } from "./sessions/extensions/archive/broccoli-archive-substrate.js"
export { AudioContainerSnapshotManager } from "./sessions/extensions/audio_container/audio-container-snapshot-manager.js"
export { BroccoliAudioContainerSubstrate } from "./sessions/extensions/audio_container/broccoli-audio-container-substrate.js"
export { AuthSnapshotManager } from "./sessions/extensions/auth/auth-snapshot-manager.js"
export { BroccoliAuthSubstrate } from "./sessions/extensions/auth/broccoli-auth-substrate.js"
export { BatchSnapshotManager } from "./sessions/extensions/batch/batch-snapshot-manager.js"
export { BroccoliBatchSubstrate } from "./sessions/extensions/batch/broccoli-batch-substrate.js"
export { BillingUsageSnapshotManager } from "./sessions/extensions/billing_usage/billing-usage-snapshot-manager.js"
export { BroccoliBillingUsageSubstrate } from "./sessions/extensions/billing_usage/broccoli-billing-usage-substrate.js"
export { BroccoliBrowserSubstrate } from "./sessions/extensions/cdp/broccoli-browser-substrate.js"
export { BrowserSnapshotManager } from "./sessions/extensions/cdp/browser-snapshot-manager.js"
export { BroccoliCheckpointSubstrate } from "./sessions/extensions/checkpoint/broccoli-checkpoint-substrate.js"
export { CheckpointSnapshotManager } from "./sessions/extensions/checkpoint/checkpoint-snapshot-manager.js"
export { BroccoliClarifySubstrate } from "./sessions/extensions/clarify/broccoli-clarify-substrate.js"
export { ClarifySnapshotManager } from "./sessions/extensions/clarify/clarify-snapshot-manager.js"
export { BroccoliCompressionSubstrate } from "./sessions/extensions/compaction/broccoli-compression-substrate.js"
export type { CasBlobRecord, ContextProjectionRecord } from "./sessions/extensions/compaction/broccolidb-cas-compactor.js"
export { BroccoliCasCompactor } from "./sessions/extensions/compaction/broccolidb-cas-compactor.js"
export { CompressionSnapshotManager } from "./sessions/extensions/compaction/compression-snapshot-manager.js"
export type {
	CompactionReason,
	CompactorOptions,
	ContextCompactionPolicy,
	ContextCompactionReport,
} from "./sessions/extensions/compaction/session-compactor.js"
export { SessionCompactor } from "./sessions/extensions/compaction/session-compactor.js"
export type { SnapcompactResult } from "./sessions/extensions/compaction/snapcompact-engine.js"
export { SnapcompactEngine } from "./sessions/extensions/compaction/snapcompact-engine.js"
export { BroccoliDisplaySubstrate } from "./sessions/extensions/computer-use/broccoli-display-substrate.js"
export { DisplaySnapshotManager } from "./sessions/extensions/computer-use/display-snapshot-manager.js"
export { BroccoliContextBreakdownSubstrate } from "./sessions/extensions/context_breakdown/broccoli-context-breakdown-substrate.js"
export { ContextBreakdownSnapshotManager } from "./sessions/extensions/context_breakdown/context-breakdown-snapshot-manager.js"
export { BroccoliCostSubstrate } from "./sessions/extensions/cost/broccoli-cost-substrate.js"
export { CostSnapshotManager } from "./sessions/extensions/cost/cost-snapshot-manager.js"
export { BroccoliCredentialSubstrate } from "./sessions/extensions/credential/broccoli-credential-substrate.js"
export { CredentialSnapshotManager } from "./sessions/extensions/credential/credential-snapshot-manager.js"
export { BroccoliCronSubstrate } from "./sessions/extensions/cron/broccoli-cron-substrate.js"
export { CronSnapshotManager } from "./sessions/extensions/cron/cron-snapshot-manager.js"
export { BroccoliDaemonSubstrate } from "./sessions/extensions/daemon/broccoli-daemon-substrate.js"
export { DaemonSnapshotManager } from "./sessions/extensions/daemon/daemon-snapshot-manager.js"
export { BroccoliDeadlineSubstrate } from "./sessions/extensions/deadline/broccoli-deadline-substrate.js"
export { DeadlineSnapshotManager } from "./sessions/extensions/deadline/deadline-snapshot-manager.js"
export { BroccoliSwarmSubstrate } from "./sessions/extensions/delegation/broccoli-swarm-substrate.js"
export { SubagentBudgetGovernor } from "./sessions/extensions/delegation/subagent-budget-governor.js"
export { SubagentVfsBrancher } from "./sessions/extensions/delegation/subagent-vfs-brancher.js"
export { SwarmSnapshotManager } from "./sessions/extensions/delegation/swarm-snapshot-manager.js"
export { BroccoliDisclosureSubstrate } from "./sessions/extensions/disclosure/broccoli-disclosure-substrate.js"
export { ToolDisclosureSnapshotManager } from "./sessions/extensions/disclosure/disclosure-snapshot-manager.js"
export { BroccoliDocExtractorSubstrate } from "./sessions/extensions/doc_extractor/broccoli-doc-extractor-substrate.js"
export { DocExtractorSnapshotManager } from "./sessions/extensions/doc_extractor/doc-extractor-snapshot-manager.js"
export { BroccoliDoctorSubstrate } from "./sessions/extensions/doctor/broccoli-doctor-substrate.js"
export { DoctorSnapshotManager } from "./sessions/extensions/doctor/doctor-snapshot-manager.js"
export { BroccoliEmailSubstrate } from "./sessions/extensions/email/broccoli-email-substrate.js"
export { EmailSnapshotManager } from "./sessions/extensions/email/email-snapshot-manager.js"
export { BroccoliEnvProbeSubstrate } from "./sessions/extensions/env_probe/broccoli-env-probe-substrate.js"
export { EnvProbeSnapshotManager } from "./sessions/extensions/env_probe/env-probe-snapshot-manager.js"
export { BroccoliEnvironmentSubstrate } from "./sessions/extensions/environments/broccoli-environment-substrate.js"
export { EnvironmentSnapshotManager } from "./sessions/extensions/environments/environment-snapshot-manager.js"
export { BroccoliEvidenceSubstrate } from "./sessions/extensions/evidence/broccoli-evidence-substrate.js"
export { EvidenceSnapshotManager } from "./sessions/extensions/evidence/evidence-snapshot-manager.js"
export { BroccoliExecutionSubstrate } from "./sessions/extensions/execution/broccoli-execution-substrate.js"
export { ExecutionSnapshotManager } from "./sessions/extensions/execution/execution-snapshot-manager.js"
export {
	BroccoliExecutionGuardSubstrate,
	BroccoliToolExecutionGuardSubstrate,
} from "./sessions/extensions/execution_guard/broccoli-execution-guard-substrate.js"
export {
	ExecutionGuardSnapshotManager,
	ToolExecutionGuardSnapshotManager,
} from "./sessions/extensions/execution_guard/execution-guard-snapshot-manager.js"
export { BroccoliFaultSubstrate } from "./sessions/extensions/faults/broccoli-fault-substrate.js"
export { FaultSnapshotManager } from "./sessions/extensions/faults/fault-snapshot-manager.js"
export { BroccoliFileSafetySubstrate } from "./sessions/extensions/file_safety/broccoli-file-safety-substrate.js"
export { FileSafetySnapshotManager } from "./sessions/extensions/file_safety/file-safety-snapshot-manager.js"
export { BroccoliFuzzySubstrate } from "./sessions/extensions/fuzzy/broccoli-fuzzy-substrate.js"
export { FuzzySnapshotManager } from "./sessions/extensions/fuzzy/fuzzy-snapshot-manager.js"
export { BroccoliGatewaySubstrate } from "./sessions/extensions/gateway/broccoli-gateway-substrate.js"
export { GatewayDeliveryLedger } from "./sessions/extensions/gateway/gateway-delivery-ledger.js"
export { GatewaySnapshotManager } from "./sessions/extensions/gateway/gateway-snapshot-manager.js"
export { BroccoliGoalSubstrate } from "./sessions/extensions/goals/broccoli-goal-substrate.js"
export { GoalSnapshotManager } from "./sessions/extensions/goals/goal-snapshot-manager.js"
export { BroccoliHeredocTerminalSubstrate } from "./sessions/extensions/heredoc_terminal/broccoli-heredoc-terminal-substrate.js"
export { HeredocTerminalSnapshotManager } from "./sessions/extensions/heredoc_terminal/heredoc-terminal-snapshot-manager.js"
export { BroccoliIntegrationsSubstrate } from "./sessions/extensions/integrations/broccoli-integrations-substrate.js"
export { IntegrationsSnapshotManager } from "./sessions/extensions/integrations/integrations-snapshot-manager.js"
export type { ContextHealthReport, DiagnosisKnowledgeNode } from "./sessions/extensions/integrity/broccolidb-context-diagnosis.js"
export { BroccoliContextDiagnosisService } from "./sessions/extensions/integrity/broccolidb-context-diagnosis.js"
export type { CleanupMetrics } from "./sessions/extensions/integrity/broccolidb-retention-cleanup.js"
export { BroccoliRetentionCleanupService } from "./sessions/extensions/integrity/broccolidb-retention-cleanup.js"
export type {
	InvariantAuditReport,
	SystemInvariantViolation,
} from "./sessions/extensions/integrity/broccolidb-system-invariant.js"
export { BroccoliSystemInvariantEngine } from "./sessions/extensions/integrity/broccolidb-system-invariant.js"
export type { ExceptionRecord, PostmortemReport } from "./sessions/extensions/integrity/postmortem-diagnostic.js"
export { PostmortemDiagnostic } from "./sessions/extensions/integrity/postmortem-diagnostic.js"
export type { ParsedSemver } from "./sessions/extensions/integrity/semantic-version-comparator.js"
export { SemanticVersionComparator } from "./sessions/extensions/integrity/semantic-version-comparator.js"
export type { EnvironmentIntegrityReport } from "./sessions/extensions/integrity/stability-doctor.js"
export { StabilityDoctor } from "./sessions/extensions/integrity/stability-doctor.js"
export type { AggregateHealthReport, SubsystemHealthStatus } from "./sessions/extensions/integrity/system-health-aggregator.js"
export { SystemHealthAggregator } from "./sessions/extensions/integrity/system-health-aggregator.js"
export { BroccoliKanbanSubstrate } from "./sessions/extensions/kanban/broccoli-kanban-substrate.js"
export { KanbanSnapshotManager } from "./sessions/extensions/kanban/kanban-snapshot-manager.js"
export { BroccoliLspSubstrate } from "./sessions/extensions/lsp/broccoli-lsp-substrate.js"
export { LspSnapshotManager } from "./sessions/extensions/lsp/lsp-snapshot-manager.js"
export { BroccoliMcpSubstrate } from "./sessions/extensions/mcp/broccoli-mcp-substrate.js"
export { McpSnapshotManager } from "./sessions/extensions/mcp/mcp-snapshot-manager.js"
export { BroccoliMediaSourceSubstrate } from "./sessions/extensions/media_source/broccoli-media-source-substrate.js"
export { MediaSourceSnapshotManager } from "./sessions/extensions/media_source/media-source-snapshot-manager.js"
export { BroccoliLearningSubstrate } from "./sessions/extensions/memory/broccoli-learning-substrate.js"
export type { ContextReadEntry, StalenessReport } from "./sessions/extensions/memory/context-staleness-tracker.js"
export { CognitiveFreshnessGuard, ContextStalenessTracker } from "./sessions/extensions/memory/context-staleness-tracker.js"
export { LearningSnapshotManager } from "./sessions/extensions/memory/learning-snapshot-manager.js"
export { SemanticKnowledgeGraph } from "./sessions/extensions/memory/semantic-knowledge-graph.js"
export { SessionMemoryStore } from "./sessions/extensions/memory/session-memory-store.js"
export { BroccoliNousPortalSubstrate } from "./sessions/extensions/nous_portal/broccoli-nous-portal-substrate.js"
export { NousPortalSnapshotManager } from "./sessions/extensions/nous_portal/nous-portal-snapshot-manager.js"
export { BroccoliOsvSubstrate } from "./sessions/extensions/osv/broccoli-osv-substrate.js"
export { OsvScannerSnapshotManager, OsvSnapshotManager } from "./sessions/extensions/osv/osv-snapshot-manager.js"
export { BroccoliOtlpSubstrate } from "./sessions/extensions/otlp/broccoli-otlp-substrate.js"
export { OtlpSnapshotManager } from "./sessions/extensions/otlp/otlp-snapshot-manager.js"
export { BroccoliPatchSubstrate } from "./sessions/extensions/patch/broccoli-patch-substrate.js"
export { PatchSnapshotManager } from "./sessions/extensions/patch/patch-snapshot-manager.js"
export type { ScratchpadRecord } from "./sessions/extensions/persistence/broccolidb-cas-scratchpad.js"
export { BroccoliCASScratchpadService } from "./sessions/extensions/persistence/broccolidb-cas-scratchpad.js"
export { BroccoliTaskStateEngine } from "./sessions/extensions/persistence/broccolidb-task-state.js"
export type { ActiveSessionInfo } from "./sessions/extensions/persistence/gateway-session-registry.js"
export { GatewaySessionRegistry } from "./sessions/extensions/persistence/gateway-session-registry.js"
export { RemoteSessionHandle } from "./sessions/extensions/persistence/remote-session-handle.js"
export { PersistentSessionStore, SessionStore } from "./sessions/extensions/persistence/session-store.js"
export type { SnapshotMetadata } from "./sessions/extensions/persistence/snapshot-storage-index.js"
export { SnapshotStorageIndex } from "./sessions/extensions/persistence/snapshot-storage-index.js"
export { BroccoliPreflightSubstrate } from "./sessions/extensions/preflight_scanner/broccoli-preflight-substrate.js"
export { PreflightSnapshotManager } from "./sessions/extensions/preflight_scanner/preflight-snapshot-manager.js"
export { BroccoliProcessSubstrate } from "./sessions/extensions/process/broccoli-process-substrate.js"
export { ProcessSnapshotManager } from "./sessions/extensions/process/process-snapshot-manager.js"
export { BroccoliProfileSubstrate } from "./sessions/extensions/profiles/broccoli-profile-substrate.js"
export { ProfileSnapshotManager } from "./sessions/extensions/profiles/profile-snapshot-manager.js"
export { BroccoliPromptCacheSubstrate } from "./sessions/extensions/prompt/broccoli-prompt-cache-substrate.js"
export { PromptCacheSnapshotManager } from "./sessions/extensions/prompt/prompt-cache-snapshot-manager.js"
export { BroccoliReasoningSubstrate } from "./sessions/extensions/reasoning/broccoli-reasoning-substrate.js"
export { ReasoningSnapshotManager } from "./sessions/extensions/reasoning/reasoning-snapshot-manager.js"
export { BroccoliRedactionSubstrate } from "./sessions/extensions/redaction/broccoli-redaction-substrate.js"
export { RedactionSnapshotManager } from "./sessions/extensions/redaction/redaction-snapshot-manager.js"
export { BroccoliReviewSubstrate } from "./sessions/extensions/review/broccoli-review-substrate.js"
export { ReviewSnapshotManager } from "./sessions/extensions/review/review-snapshot-manager.js"
export { AuxiliarySnapshotManager } from "./sessions/extensions/router/auxiliary-snapshot-manager.js"
export { BroccoliAuxiliarySubstrate } from "./sessions/extensions/router/broccoli-auxiliary-substrate.js"
export { BroccoliSchemaSanitizerSubstrate } from "./sessions/extensions/schema_sanitizer/broccoli-schema-sanitizer-substrate.js"
export { SchemaSanitizerSnapshotManager } from "./sessions/extensions/schema_sanitizer/schema-sanitizer-snapshot-manager.js"
export { BroccoliSearchSubstrate } from "./sessions/extensions/search/broccoli-search-substrate.js"
export { SearchSnapshotManager } from "./sessions/extensions/search/search-snapshot-manager.js"
export { BroccoliSelfRepoGuardSubstrate } from "./sessions/extensions/self_repo_guard/broccoli-self-repo-guard-substrate.js"
export { SelfRepoGuardSnapshotManager } from "./sessions/extensions/self_repo_guard/self-repo-guard-snapshot-manager.js"
export { BroccoliSkillLinterSubstrate } from "./sessions/extensions/skill_linter/broccoli-skill-linter-substrate.js"
export { SkillLinterSnapshotManager } from "./sessions/extensions/skill_linter/skill-linter-snapshot-manager.js"
export { BroccoliSkillTreeSubstrate } from "./sessions/extensions/skills/broccoli-skill-tree-substrate.js"
export { DeterministicSkillCurator } from "./sessions/extensions/skills/deterministic-skill-curator.js"
export { SkillTreeSnapshotManager } from "./sessions/extensions/skills/skill-tree-snapshot-manager.js"
export { BroccoliSkillsSyncSubstrate } from "./sessions/extensions/skills_sync/broccoli-skills-sync-substrate.js"
export { SkillsSyncSnapshotManager } from "./sessions/extensions/skills_sync/skills-sync-snapshot-manager.js"
export { BroccoliSkillsHubSubstrate } from "./sessions/extensions/skills-hub/broccoli-skills-hub-substrate.js"
export { SkillsHubSnapshotManager } from "./sessions/extensions/skills-hub/skills-hub-snapshot-manager.js"
export { BroccoliSkinSubstrate } from "./sessions/extensions/skin/broccoli-skin-substrate.js"
export { SkinSnapshotManager } from "./sessions/extensions/skin/skin-snapshot-manager.js"
export { BroccoliSoulSubstrate } from "./sessions/extensions/soul/broccoli-soul-substrate.js"
export { SoulSnapshotManager } from "./sessions/extensions/soul/soul-snapshot-manager.js"
export { BroccoliSpeechNormalizerSubstrate } from "./sessions/extensions/speech_normalizer/broccoli-speech-normalizer-substrate.js"
export { SpeechNormalizerSnapshotManager } from "./sessions/extensions/speech_normalizer/speech-normalizer-snapshot-manager.js"
export { BroccoliSpillVaultSubstrate } from "./sessions/extensions/spill_vault/broccoli-spill-vault-substrate.js"
export { SpillVaultSnapshotManager } from "./sessions/extensions/spill_vault/spill-vault-snapshot-manager.js"
export { BroccoliStealthBrowserSubstrate } from "./sessions/extensions/stealth_browser/broccoli-stealth-browser-substrate.js"
export { StealthBrowserSnapshotManager } from "./sessions/extensions/stealth_browser/stealth-browser-snapshot-manager.js"
export { BroccoliStreamDiagSubstrate } from "./sessions/extensions/stream_diag/broccoli-stream-diag-substrate.js"
export { StreamDiagSnapshotManager } from "./sessions/extensions/stream_diag/stream-diag-snapshot-manager.js"
export { BroccoliStreamingScrubberSubstrate } from "./sessions/extensions/streaming_scrubber/broccoli-streaming-scrubber-substrate.js"
export { StreamingScrubberSnapshotManager } from "./sessions/extensions/streaming_scrubber/streaming-scrubber-snapshot-manager.js"
export { BroccoliSubdirHintsSubstrate } from "./sessions/extensions/subdir_hints/broccoli-subdir-hints-substrate.js"
export { SubdirHintsSnapshotManager } from "./sessions/extensions/subdir_hints/subdir-hints-snapshot-manager.js"
export { ArenaAllocator } from "./sessions/extensions/substrate/arena-allocator.js"
export type {
	SubstrateEntity,
	SubstrateQueryFilter,
	SubstrateTransactionCheckpoint,
} from "./sessions/extensions/substrate/broccoli-substrate-store.js"
export { BroccoliSubstrateStore } from "./sessions/extensions/substrate/broccoli-substrate-store.js"
export { BroccoliTwoPhaseCommitCoordinator } from "./sessions/extensions/substrate/broccolidb-2pc-coordinator.js"
export { BroccoliAggregateEngine } from "./sessions/extensions/substrate/broccolidb-aggregation.js"
export { BroccoliBranchingEngine } from "./sessions/extensions/substrate/broccolidb-branching.js"
export { BroccoliBTreeIndexEngine } from "./sessions/extensions/substrate/broccolidb-btree-index-engine.js"
export { BroccoliBufferPoolManager } from "./sessions/extensions/substrate/broccolidb-buffer-pool-manager.js"
export { BroccoliCASStorageService } from "./sessions/extensions/substrate/broccolidb-cas.js"
export { BroccoliCdcStream } from "./sessions/extensions/substrate/broccolidb-cdc-stream.js"
export { BroccoliConnectionPool } from "./sessions/extensions/substrate/broccolidb-connection-pool.js"
export { BroccoliConsistentHashRing } from "./sessions/extensions/substrate/broccolidb-consistent-hash-ring.js"
export { BroccoliDeadlockDetector } from "./sessions/extensions/substrate/broccolidb-deadlock-detector.js"
export type { FencingLockRecord } from "./sessions/extensions/substrate/broccolidb-fencing-mutex.js"
export { BroccoliFencingMutexEngine } from "./sessions/extensions/substrate/broccolidb-fencing-mutex.js"
export { BroccoliInvertedIndexEngine } from "./sessions/extensions/substrate/broccolidb-inverted-index-engine.js"
export { BroccoliDatabaseKernel } from "./sessions/extensions/substrate/broccolidb-kernel.js"
export { BroccoliLockAuthority } from "./sessions/extensions/substrate/broccolidb-lock-authority.js"
export { BroccoliLsmStore } from "./sessions/extensions/substrate/broccolidb-lsm-store.js"
export { BroccoliMaterializedViewEngine } from "./sessions/extensions/substrate/broccolidb-materialized-view-engine.js"
export { DatabaseLockError, DeadlockTimeoutError, ReentrantAsyncMutex } from "./sessions/extensions/substrate/broccolidb-mutex.js"
export { BroccoliMvccEngine } from "./sessions/extensions/substrate/broccolidb-mvcc-engine.js"
export { BroccoliNaturalQueryParser } from "./sessions/extensions/substrate/broccolidb-natural-query.js"
export { BroccoliAdaptivePlanCache } from "./sessions/extensions/substrate/broccolidb-plan-cache.js"
export { BroccoliQueryOptimizer } from "./sessions/extensions/substrate/broccolidb-query-optimizer.js"
export { BroccoliRaftConsensusEngine } from "./sessions/extensions/substrate/broccolidb-raft-consensus.js"
export { BroccoliRelationEngine } from "./sessions/extensions/substrate/broccolidb-relations.js"
export type { FileSnapshotRecord, RollbackResult } from "./sessions/extensions/substrate/broccolidb-rollback-coordinator.js"
export { BroccoliRollbackCoordinator } from "./sessions/extensions/substrate/broccolidb-rollback-coordinator.js"
export { BroccoliSagaOrchestrator } from "./sessions/extensions/substrate/broccolidb-saga-orchestrator.js"
export { BroccoliSchemaEngine } from "./sessions/extensions/substrate/broccolidb-schema-engine.js"
export { BroccoliSparseIndexEngine } from "./sessions/extensions/substrate/broccolidb-sparse-index-engine.js"
export { BroccoliDbTable } from "./sessions/extensions/substrate/broccolidb-table.js"
export { BroccoliTieredKvCache } from "./sessions/extensions/substrate/broccolidb-tiered-kv-cache.js"
export { BroccoliTimeSeriesRollupEngine } from "./sessions/extensions/substrate/broccolidb-timeseries-rollup-engine.js"
export { BroccoliVectorAnnEngine } from "./sessions/extensions/substrate/broccolidb-vector-ann-engine.js"
export { BroccoliVectorEngine } from "./sessions/extensions/substrate/broccolidb-vector-engine.js"
export { BroccoliViewRenderer } from "./sessions/extensions/substrate/broccolidb-view-renderer.js"
export { BroccoliWriteAheadLog } from "./sessions/extensions/substrate/broccolidb-wal.js"
export { FileLockManager, LruCache } from "./sessions/extensions/substrate/file-lock.js"
export type {
	LockAcquireResult,
	LockClaim,
	LockReleaseResult,
	StaleRecoveryReport,
} from "./sessions/extensions/substrate/lock-authority.js"
export { BroccoliFencingSubstrate, LockAuthorityEngine } from "./sessions/extensions/substrate/lock-authority.js"
export type { MutationResult, MutationTransaction } from "./sessions/extensions/substrate/native-mutation-substrate.js"
export {
	getNormalizedHash,
	isPathInWorkspace,
	NativeMutationTransactionSubstrate,
} from "./sessions/extensions/substrate/native-mutation-substrate.js"
export { FixedRingBuffer } from "./sessions/extensions/substrate/ring-buffer.js"
export { SnowflakeIdGenerator } from "./sessions/extensions/substrate/snowflake-id-generator.js"
export type { SystemDirectories } from "./sessions/extensions/substrate/system-directory-resolver.js"
export { SystemDirectoryResolver } from "./sessions/extensions/substrate/system-directory-resolver.js"
export type { CoalescerStats, PendingWrite } from "./sessions/extensions/substrate/write-coalescer.js"
export { calculateFastHash, WriteCoalescerSubstrate } from "./sessions/extensions/substrate/write-coalescer.js"
export { BroccoliTerminalCleanerSubstrate } from "./sessions/extensions/terminal_cleaner/broccoli-terminal-cleaner-substrate.js"
export { TerminalCleanerSnapshotManager } from "./sessions/extensions/terminal_cleaner/terminal-cleaner-snapshot-manager.js"
export { BroccoliThreadContextSubstrate } from "./sessions/extensions/thread_context/broccoli-thread-context-substrate.js"
export { ThreadContextSnapshotManager } from "./sessions/extensions/thread_context/thread-context-snapshot-manager.js"
export { BroccoliThreatSubstrate } from "./sessions/extensions/threat/broccoli-threat-substrate.js"
export { ThreatSnapshotManager } from "./sessions/extensions/threat/threat-snapshot-manager.js"
export { BroccoliTitleInsightsSubstrate } from "./sessions/extensions/title_insights/broccoli-title-insights-substrate.js"
export { TitleInsightsSnapshotManager } from "./sessions/extensions/title_insights/title-insights-snapshot-manager.js"
export { BroccoliTranscriptionSubstrate } from "./sessions/extensions/transcription/broccoli-transcription-substrate.js"
export { TranscriptionSnapshotManager } from "./sessions/extensions/transcription/transcription-snapshot-manager.js"
export { BroccoliTurnRetrySubstrate } from "./sessions/extensions/turn_retry/broccoli-turn-retry-substrate.js"
export { TurnRetrySnapshotManager } from "./sessions/extensions/turn_retry/turn-retry-snapshot-manager.js"
export { BroccoliUrlSafetySubstrate } from "./sessions/extensions/url_safety/broccoli-url-safety-substrate.js"
export { UrlSafetySnapshotManager } from "./sessions/extensions/url_safety/url-safety-snapshot-manager.js"
export { BroccoliV4aPatchSubstrate } from "./sessions/extensions/v4a_patch/broccoli-v4a-patch-substrate.js"
export { V4aPatchSnapshotManager } from "./sessions/extensions/v4a_patch/v4a-patch-snapshot-manager.js"
export { GitIgnoreFilter } from "./sessions/extensions/vfs/git-ignore-filter.js"
export { SessionVfs } from "./sessions/extensions/vfs/session-vfs.js"
export type { FileTreeNode } from "./sessions/extensions/vfs/workspace-tree-walker.js"
export { WorkspaceTreeWalker } from "./sessions/extensions/vfs/workspace-tree-walker.js"
export { BroccoliVisionSubstrate } from "./sessions/extensions/vision/broccoli-vision-substrate.js"
export { VisionSnapshotManager } from "./sessions/extensions/vision/vision-snapshot-manager.js"
export { BroccoliVoiceSubstrate } from "./sessions/extensions/voice/broccoli-voice-substrate.js"
export { VoiceSnapshotManager } from "./sessions/extensions/voice/voice-snapshot-manager.js"
export { BroccoliWakeWordSubstrate } from "./sessions/extensions/wake_word/broccoli-wake-word-substrate.js"
export { WakeWordSnapshotManager } from "./sessions/extensions/wake_word/wake-word-snapshot-manager.js"
export { BroccoliWalletSubstrate } from "./sessions/extensions/wallet/broccoli-wallet-substrate.js"
export { WalletSnapshotManager } from "./sessions/extensions/wallet/wallet-snapshot-manager.js"
export { BroccoliWebSubstrate } from "./sessions/extensions/web/broccoli-web-substrate.js"
export { WebSnapshotManager } from "./sessions/extensions/web/web-snapshot-manager.js"
export { BroccoliWebsitePolicySubstrate } from "./sessions/extensions/website_policy/broccoli-website-policy-substrate.js"
export { WebsitePolicySnapshotManager } from "./sessions/extensions/website_policy/website-policy-snapshot-manager.js"
export { BroccoliWorktreeSubstrate } from "./sessions/extensions/worktree/broccoli-worktree-substrate.js"
export { WorktreeSnapshotManager } from "./sessions/extensions/worktree/worktree-snapshot-manager.js"
export { Eyes } from "./tooling/base/eyes.js"
export { AcpPermissionGate } from "./tooling/extensions/acp/acp-permission-gate.js"
export { AcpProtocolCodec } from "./tooling/extensions/acp/acp-protocol-codec.js"
export { AcpToolSuite } from "./tooling/extensions/acp/acp-tool-suite.js"
export { DeterministicAcpEngine } from "./tooling/extensions/acp/deterministic-acp-engine.js"
export { AdversarialToolSuite } from "./tooling/extensions/adversarial/adversarial-tool-suite.js"
export { ApprovalHashLedger } from "./tooling/extensions/arbiter/approval-hash-ledger.js"
export { ArbiterToolSuite } from "./tooling/extensions/arbiter/arbiter-tool-suite.js"
export { SecurityRiskClassifier } from "./tooling/extensions/arbiter/security-risk-classifier.js"
export { DeterministicSessionArchiver } from "./tooling/extensions/archive/deterministic-session-archiver.js"
export { SessionArchiveToolSuite } from "./tooling/extensions/archive/session-archive-tool-suite.js"
export { AudioContainerToolSuite } from "./tooling/extensions/audio_container/audio-container-tool-suite.js"
export { DeterministicAuthFederator } from "./tooling/extensions/auth/deterministic-auth-federator.js"
export { IdentityFederationToolSuite } from "./tooling/extensions/auth/identity-federation-tool-suite.js"
export { BatchEvaluationToolSuite } from "./tooling/extensions/batch/batch-evaluation-tool-suite.js"
export { DeterministicBatchEvaluator } from "./tooling/extensions/batch/deterministic-batch-evaluator.js"
export { BillingUsageToolSuite } from "./tooling/extensions/billing_usage/billing-usage-tool-suite.js"
export type { ContractValidationResult } from "./tooling/extensions/cache/broccolidb-joyride-contract.js"
export {
	BroccoliJoyRideContractVerifier,
	JOYRIDE_FORBIDDEN_EXPORTS,
} from "./tooling/extensions/cache/broccolidb-joyride-contract.js"
export type { DecisionType, JoyRideCacheDecision } from "./tooling/extensions/cache/broccolidb-joyride-decision-log.js"
export { BroccoliJoyRideDecisionLog } from "./tooling/extensions/cache/broccolidb-joyride-decision-log.js"
export type { JoyRideDiagnosticMetrics } from "./tooling/extensions/cache/broccolidb-joyride-diagnostics.js"
export { BroccoliJoyRideDiagnostics } from "./tooling/extensions/cache/broccolidb-joyride-diagnostics.js"
export type {
	CommandSafetyTier,
	JoyRideCacheEntry,
	JoyRideCacheKind,
	JoyRideCacheStats,
} from "./tooling/extensions/cache/joyride-cache.js"
export { HotPathCommandClassifier, JoyRideHotPathCache } from "./tooling/extensions/cache/joyride-cache.js"
export { CdpDomSnapshotter } from "./tooling/extensions/cdp/cdp-dom-snapshotter.js"
export { CdpProtocolClient } from "./tooling/extensions/cdp/cdp-protocol-client.js"
export { CdpToolSuite } from "./tooling/extensions/cdp/cdp-tool-suite.js"
export { CheckpointKernelToolSuite } from "./tooling/extensions/checkpoint/checkpoint-kernel-tool-suite.js"
export { DeterministicCasStore } from "./tooling/extensions/checkpoint/deterministic-cas-store.js"
export { ClarifyInquiryToolSuite } from "./tooling/extensions/clarify/clarify-inquiry-tool-suite.js"
export { DeterministicClarifyEngine } from "./tooling/extensions/clarify/deterministic-clarify-engine.js"
export { CompressionToolSuite } from "./tooling/extensions/compaction/compression-tool-suite.js"
export { DeterministicToolPruner } from "./tooling/extensions/compaction/deterministic-tool-pruner.js"
export { HeadTailBudgetGovernor } from "./tooling/extensions/compaction/head-tail-budget-governor.js"
export { StatefulCompactionSynthesizer } from "./tooling/extensions/compaction/stateful-compaction-synthesizer.js"
export { ComputerUseToolSuite } from "./tooling/extensions/computer-use/computer-use-tool-suite.js"
export { DeterministicDisplayDriver } from "./tooling/extensions/computer-use/deterministic-display-driver.js"
export { ContextBreakdownToolSuite } from "./tooling/extensions/context_breakdown/context-breakdown-tool-suite.js"
export { CostGovernanceToolSuite } from "./tooling/extensions/cost/cost-governance-tool-suite.js"
export { DeterministicCostGovernor } from "./tooling/extensions/cost/deterministic-cost-governor.js"
export { CredentialToolSuite } from "./tooling/extensions/credential/credential-tool-suite.js"
export { DeterministicCredentialPool } from "./tooling/extensions/credential/deterministic-credential-pool.js"
export { TokenBucketRateGovernor as ContinuousTokenBucketRateGovernor } from "./tooling/extensions/credential/token-bucket-rate-governor.js"
export { AnchoredCronJobManager } from "./tooling/extensions/cron/anchored-cron-job-manager.js"
export {
	CronDesktopNotificationDispatcher,
	DEFAULT_CRON_NOTIFICATION_PREFERENCES,
} from "./tooling/extensions/cron/cron-notification-dispatcher.js"
export { CronToolSuite } from "./tooling/extensions/cron/cron-tool-suite.js"
export { DeterministicBlueprintCatalog } from "./tooling/extensions/cron/deterministic-blueprint-catalog.js"
export { DaemonToolSuite } from "./tooling/extensions/daemon/daemon-tool-suite.js"
export { DeterministicDaemonEngine } from "./tooling/extensions/daemon/deterministic-daemon-engine.js"
export { DatabaseToolSuite } from "./tooling/extensions/database/database-tools.js"
export { DeadlineToolSuite } from "./tooling/extensions/deadline/deadline-tool-suite.js"
export { AnchoredWorktreeManager } from "./tooling/extensions/delegation/anchored-worktree-manager.js"
export {
	DEFAULT_SWARM_NOTIFICATION_PREFERENCES,
	SwarmDesktopNotificationDispatcher,
} from "./tooling/extensions/delegation/swarm-notification-dispatcher.js"
export { SwarmToolSuite } from "./tooling/extensions/delegation/swarm-tool-suite.js"
export { DeterministicToolDiscloser } from "./tooling/extensions/disclosure/deterministic-tool-discloser.js"
export { ToolDisclosureToolSuite } from "./tooling/extensions/disclosure/tool-disclosure-tool-suite.js"
export { DocExtractorToolSuite } from "./tooling/extensions/doc_extractor/doc-extractor-tool-suite.js"
export { DeterministicDiagnosticDoctor } from "./tooling/extensions/doctor/deterministic-diagnostic-doctor.js"
export { DiagnosticDoctorToolSuite } from "./tooling/extensions/doctor/diagnostic-doctor-tool-suite.js"
export { DeterministicEmailEngine } from "./tooling/extensions/email/deterministic-email-engine.js"
export {
	DEFAULT_EMAIL_NOTIFICATION_PREFERENCES,
	EmailDesktopNotificationDispatcher,
} from "./tooling/extensions/email/email-notification-dispatcher.js"
export { EmailToolSuite } from "./tooling/extensions/email/email-tool-suite.js"
export {
	DEFAULT_LOCAL_ENDPOINT_PRESETS,
	DeterministicLocalEndpointEngine,
	LOCAL_QUICKSTART_GUIDES,
} from "./tooling/extensions/endpoints/deterministic-local-endpoint-engine.js"
export { LocalContextAutoTuner } from "./tooling/extensions/endpoints/local-context-auto-tuner.js"
export { LocalEmbeddingsEngine } from "./tooling/extensions/endpoints/local-embeddings-engine.js"
export { LocalHardwareProfiler } from "./tooling/extensions/endpoints/local-hardware-profiler.js"
export { LocalInferenceSpeedometer, type SpeedometerOptions } from "./tooling/extensions/endpoints/local-inference-speedometer.js"
export { LocalModelPuller, type PullModelOptions } from "./tooling/extensions/endpoints/local-model-puller.js"
export { LocalProcessSupervisor } from "./tooling/extensions/endpoints/local-process-supervisor.js"
export { type LoadedModelRecord, LocalVramReclaimer } from "./tooling/extensions/endpoints/local-vram-reclaimer.js"
export { EnvProbeToolSuite } from "./tooling/extensions/env_probe/env-probe-tool-suite.js"
export { DockerEnvironmentAdapter } from "./tooling/extensions/environments/docker-environment-adapter.js"
export { EnvironmentToolSuite } from "./tooling/extensions/environments/environment-tool-suite.js"
export { LocalEnvironmentAdapter } from "./tooling/extensions/environments/local-environment-adapter.js"
export { SecretScrubber } from "./tooling/extensions/environments/secret-scrubber.js"
export type {
	BenchmarkAssertionResult,
	BenchmarkCaseExecution,
	BenchmarkSuiteResult,
	BenchmarkTestCase,
	BenchmarkTestResult,
} from "./tooling/extensions/evals/benchmark-evaluator.js"
export { MonolithBenchmarkEvaluator } from "./tooling/extensions/evals/benchmark-evaluator.js"
export type { FlappyBirdBenchmarkCheck } from "./tooling/extensions/evals/flappy-bird-project-benchmark.js"
export { FlappyBirdProjectBenchmark } from "./tooling/extensions/evals/flappy-bird-project-benchmark.js"
export type { LiveBaselineInput, LiveBaselineWriteResult } from "./tooling/extensions/evals/live-baseline-reporter.js"
export { LiveBaselineReporter } from "./tooling/extensions/evals/live-baseline-reporter.js"
export type { GrandBenchmarkResult } from "./tooling/extensions/evals/master-benchmark-orchestrator.js"
export { MasterBenchmarkOrchestrator } from "./tooling/extensions/evals/master-benchmark-orchestrator.js"
export type { RuntimeSmokeCheckResult, RuntimeSmokeReport } from "./tooling/extensions/evals/runtime-smoke-suite.js"
export { RuntimeSmokeSuite } from "./tooling/extensions/evals/runtime-smoke-suite.js"
export { DeterministicEvidenceLedger } from "./tooling/extensions/evidence/deterministic-evidence-ledger.js"
export { VerificationEvidenceToolSuite } from "./tooling/extensions/evidence/verification-evidence-tool-suite.js"
export { CodeExecutionToolSuite } from "./tooling/extensions/execution/code-execution-tool-suite.js"
export { DeterministicCodeExecutor } from "./tooling/extensions/execution/deterministic-code-executor.js"
export { DeterministicToolSegmenter } from "./tooling/extensions/execution_guard/deterministic-tool-segmenter.js"
export { ToolExecutionGuardToolSuite } from "./tooling/extensions/execution_guard/tool-execution-guard-tool-suite.js"
export { DeterministicErrorClassifier } from "./tooling/extensions/faults/deterministic-error-classifier.js"
export { FaultDiagnosticToolSuite } from "./tooling/extensions/faults/fault-diagnostic-tool-suite.js"
export { JitteredBackoffGovernor } from "./tooling/extensions/faults/jittered-backoff-governor.js"
export { FileSafetyToolSuite } from "./tooling/extensions/file_safety/file-safety-tool-suite.js"
export {
	ALL_STRATEGIES,
	DEFAULT_UNICODE_MAP,
	DeterministicFuzzyMatcher,
	IDENTICAL_STRINGS_ERROR,
} from "./tooling/extensions/fuzzy/deterministic-fuzzy-matcher.js"
export { FuzzyMatcherToolSuite } from "./tooling/extensions/fuzzy/fuzzy-matcher-tool-suite.js"
export { AbstractPlatformAdapter } from "./tooling/extensions/gateway/abstract-platform-adapter.js"
export { DeterministicGatewayEngine } from "./tooling/extensions/gateway/deterministic-gateway-engine.js"
export { GatewayToolSuite } from "./tooling/extensions/gateway/gateway-tool-suite.js"
export { MonolithGatewayServer } from "./tooling/extensions/gateway/monolith-gateway-server.js"
export { DiscordProtocolAdapter } from "./tooling/extensions/gateway/platform-adapters/discord-protocol-adapter.js"
export { SlackProtocolAdapter } from "./tooling/extensions/gateway/platform-adapters/slack-protocol-adapter.js"
export { TelegramProtocolAdapter } from "./tooling/extensions/gateway/platform-adapters/telegram-protocol-adapter.js"
export { WebhookProtocolAdapter } from "./tooling/extensions/gateway/platform-adapters/webhook-protocol-adapter.js"
export type { ConnectionHealth } from "./tooling/extensions/gateway/transport-connection-controller.js"
export { TransportConnectionController } from "./tooling/extensions/gateway/transport-connection-controller.js"
export { GoalDesktopNotificationDispatcher } from "./tooling/extensions/goals/goal-notification-dispatcher.js"
export { GoalToolSuite } from "./tooling/extensions/goals/goal-tool-suite.js"
export type { BatchEditTask } from "./tooling/extensions/hashline/batch-edit-anchorer.js"
export { BatchEditAnchorer } from "./tooling/extensions/hashline/batch-edit-anchorer.js"
export { DiffSynthesizer } from "./tooling/extensions/hashline/diff-synthesizer.js"
export { AnchoredHands, Hands } from "./tooling/extensions/hashline/hands.js"
export { TabSpacingNormalizer } from "./tooling/extensions/hashline/tab-spacing-normalizer.js"
export { HeredocTerminalToolSuite } from "./tooling/extensions/heredoc_terminal/heredoc-terminal-tool-suite.js"
export { DeterministicIntegrationsEngine } from "./tooling/extensions/integrations/deterministic-integrations-engine.js"
export { IntegrationsToolSuite } from "./tooling/extensions/integrations/integrations-tool-suite.js"
export { DeterministicKanbanEngine } from "./tooling/extensions/kanban/deterministic-kanban-engine.js"
export { KanbanDesktopNotificationDispatcher } from "./tooling/extensions/kanban/kanban-notification-dispatcher.js"
export { KanbanOrchestrationToolSuite } from "./tooling/extensions/kanban/kanban-orchestration-tool-suite.js"
export { DeterministicLspEngine } from "./tooling/extensions/lsp/deterministic-lsp-engine.js"
export { LspCodeIntelligenceToolSuite } from "./tooling/extensions/lsp/lsp-code-intelligence-tool-suite.js"
export { McpClientToolSuite } from "./tooling/extensions/mcp/mcp-client-tool-suite.js"
export type { McpDiscoveredTool } from "./tooling/extensions/mcp/mcp-hub.js"
export { McpHub } from "./tooling/extensions/mcp/mcp-hub.js"
export { McpSecurityScrubber } from "./tooling/extensions/mcp/mcp-security-scrubber.js"
export { McpTransportCodec } from "./tooling/extensions/mcp/mcp-transport-codec.js"
export { MediaSourceToolSuite } from "./tooling/extensions/media_source/media-source-tool-suite.js"
export { LearningCuratorToolSuite } from "./tooling/extensions/memory/learning-curator-tool-suite.js"
export { NousPortalToolSuite } from "./tooling/extensions/nous_portal/nous-portal-tool-suite.js"
export { OsvScannerToolSuite } from "./tooling/extensions/osv/osv-scanner-tool-suite.js"
export { DeterministicOtlpEngine } from "./tooling/extensions/otlp/deterministic-otlp-engine.js"
export { OtlpToolSuite } from "./tooling/extensions/otlp/otlp-tool-suite.js"
export { DeterministicPatchEngine } from "./tooling/extensions/patch/deterministic-patch-engine.js"
export { FileMutationToolSuite } from "./tooling/extensions/patch/file-mutation-tool-suite.js"
export type { SymbolSearchResult } from "./tooling/extensions/perception/ast-eyes.js"
export { AstPerceptionEyes } from "./tooling/extensions/perception/ast-eyes.js"
export type {
	LspDiagnostic as BroccoliLspDiagnostic,
	LspLocation,
} from "./tooling/extensions/perception/broccolidb-lsp-bridge.js"
export { BroccoliLspProtocolBridge } from "./tooling/extensions/perception/broccolidb-lsp-bridge.js"
export type { StructuralBlastRadius } from "./tooling/extensions/perception/broccolidb-structural-discovery.js"
export { BroccoliStructuralDiscoveryService } from "./tooling/extensions/perception/broccolidb-structural-discovery.js"
export type { PeekFileResult } from "./tooling/extensions/perception/file-peeker.js"
export { BoundedFilePeeker } from "./tooling/extensions/perception/file-peeker.js"
export type { FrontmatterResult } from "./tooling/extensions/perception/frontmatter-parser.js"
export { FrontmatterParser } from "./tooling/extensions/perception/frontmatter-parser.js"
export type { SyntaxSymbol } from "./tooling/extensions/perception/language-syntax-parser.js"
export { LanguageSyntaxParser } from "./tooling/extensions/perception/language-syntax-parser.js"
export { NativeClipboardBridge } from "./tooling/extensions/perception/native-clipboard.js"
export type { RipgrepMatch } from "./tooling/extensions/perception/ripgrep-search-service.js"
export { RipgrepSearchService } from "./tooling/extensions/perception/ripgrep-search-service.js"
export { UrlContentFetcher } from "./tooling/extensions/perception/url-content-fetcher.js"
export type {
	ApprovalPolicy,
	PolicyDecision,
	RepairRiskLevel,
} from "./tooling/extensions/permissions/broccolidb-approval-policy.js"
export { BroccoliApprovalPolicyEngine, PolicyBlockedError } from "./tooling/extensions/permissions/broccolidb-approval-policy.js"
export type {
	JoyZoningSteeringThresholds,
	WorkspaceArchitectureMode,
	WorkspaceArchitectureProfileResult,
} from "./tooling/extensions/permissions/broccolidb-architecture-profiler.js"
export {
	BroccoliWorkspaceArchitectureProfiler,
	DEFAULT_JOY_ZONING_STEERING_THRESHOLDS,
} from "./tooling/extensions/permissions/broccolidb-architecture-profiler.js"
export type { AxiomVerificationResult } from "./tooling/extensions/permissions/broccolidb-axiom-verifier.js"
export { BroccoliAxiomVerifier } from "./tooling/extensions/permissions/broccolidb-axiom-verifier.js"
export type { CommandDiagnosticResult } from "./tooling/extensions/permissions/broccolidb-command-diagnostics.js"
// Phase 60: Command Diagnostics & Output Buffer
export { BroccoliCommandDiagnostics } from "./tooling/extensions/permissions/broccolidb-command-diagnostics.js"
export type { CommandValidationResult } from "./tooling/extensions/permissions/broccolidb-command-sanitizer.js"
export { BroccoliCommandSanitizer } from "./tooling/extensions/permissions/broccolidb-command-sanitizer.js"
export type { OptimizationOpportunity } from "./tooling/extensions/permissions/broccolidb-integrity-optimizer.js"
export { BroccoliIntegrityOptimizer } from "./tooling/extensions/permissions/broccolidb-integrity-optimizer.js"
export type { TriadAuditCheck } from "./tooling/extensions/permissions/broccolidb-integrity-protocol.js"
export { BroccoliIntegrityProtocol } from "./tooling/extensions/permissions/broccolidb-integrity-protocol.js"
export type { CommentStyle, JoyLayer } from "./tooling/extensions/permissions/broccolidb-joy-zoning.js"
export { BroccoliJoyZoningEngine, CommentStyleMap } from "./tooling/extensions/permissions/broccolidb-joy-zoning.js"
export type { BoundaryValidationResult, BoundaryViolation } from "./tooling/extensions/permissions/broccolidb-joy-zoning-guard.js"
export { BroccoliJoyZoningGuard } from "./tooling/extensions/permissions/broccolidb-joy-zoning-guard.js"
export type {
	DecompositionAction,
	DecompositionPlan,
	DecompositionStep,
} from "./tooling/extensions/permissions/broccolidb-module-decomposer.js"
export { BroccoliJoyZoningModuleDecomposer } from "./tooling/extensions/permissions/broccolidb-module-decomposer.js"
export type {
	ReactiveObservationResult,
	ToolExecutionPayload,
} from "./tooling/extensions/permissions/broccolidb-reactive-policy.js"
export { BroccoliReactivePolicyObserver } from "./tooling/extensions/permissions/broccolidb-reactive-policy.js"
export type { AxiomViolation } from "./tooling/extensions/permissions/broccolidb-semantic-axiom.js"
export { BroccoliSemanticAxiomEngine } from "./tooling/extensions/permissions/broccolidb-semantic-axiom.js"
export type { ShellProfile } from "./tooling/extensions/permissions/broccolidb-shell-resolver.js"
export { BroccoliShellEnvironmentResolver } from "./tooling/extensions/permissions/broccolidb-shell-resolver.js"
export type { SimulationResult } from "./tooling/extensions/permissions/broccolidb-simulation-engine.js"
export { BroccoliSimulationEngine } from "./tooling/extensions/permissions/broccolidb-simulation-engine.js"
export type { ForensicVerificationResult } from "./tooling/extensions/permissions/broccolidb-stability-forensics.js"
export { BroccoliStabilityForensics } from "./tooling/extensions/permissions/broccolidb-stability-forensics.js"
export type {
	EnforcementTheme,
	ExceptionRule,
	PolicyEvaluationResult,
} from "./tooling/extensions/permissions/broccolidb-tsp-policy.js"
export { BroccoliTspPolicyPlugin } from "./tooling/extensions/permissions/broccolidb-tsp-policy.js"
export type { ExecutionMode } from "./tooling/extensions/permissions/broccolidb-universal-guard.js"
export { BroccoliUniversalGuard } from "./tooling/extensions/permissions/broccolidb-universal-guard.js"
export { CommandPathResolver } from "./tooling/extensions/permissions/command-path-resolver.js"
export type { PermissionValidationResult } from "./tooling/extensions/permissions/command-permission-controller.js"
export { CommandPermissionController } from "./tooling/extensions/permissions/command-permission-controller.js"
export type { KeybindingBinding } from "./tooling/extensions/permissions/keybindings-controller.js"
export { KeybindingsController } from "./tooling/extensions/permissions/keybindings-controller.js"
export type { IgnorePolicyStatus } from "./tooling/extensions/permissions/lumi-ignore-controller.js"
export { LumiIgnorePolicyController } from "./tooling/extensions/permissions/lumi-ignore-controller.js"
export type { ProcessHandle } from "./tooling/extensions/permissions/process-lifecycle-manager.js"
export { ProcessLifecycleManager } from "./tooling/extensions/permissions/process-lifecycle-manager.js"
export type { ConventionalCommitResult } from "./tooling/extensions/policy/agentic-commit-generator.js"
export { AgenticCommitGenerator } from "./tooling/extensions/policy/agentic-commit-generator.js"
export type { GuardrailAuditReport, GuardrailCheckResult } from "./tooling/extensions/policy/architecture-guardrail-gate.js"
export { ArchitectureGuardrailGate } from "./tooling/extensions/policy/architecture-guardrail-gate.js"
export type { CircuitState, CircuitStatus } from "./tooling/extensions/policy/broccoli-circuit-breaker.js"
export { BroccoliCircuitBreaker, TokenBucketRateGovernor } from "./tooling/extensions/policy/broccoli-circuit-breaker.js"
export type { TokenEstimationReport } from "./tooling/extensions/policy/broccolidb-token-estimator.js"
export { BroccoliTokenEstimator } from "./tooling/extensions/policy/broccolidb-token-estimator.js"
export type { CentennialMilestone } from "./tooling/extensions/policy/centennial-pass-marker.js"
export { CentennialPassMarker } from "./tooling/extensions/policy/centennial-pass-marker.js"
export { ModuleDecomposer } from "./tooling/extensions/policy/module-decomposer.js"
export type { CheckpointDigest } from "./tooling/extensions/policy/roadmap-checkpoint-digest.js"
export { RoadmapCheckpointDigest } from "./tooling/extensions/policy/roadmap-checkpoint-digest.js"
export type {
	AttemptDiff,
	AttemptFingerprint,
	AttemptGateEvaluationContext,
	AttemptGateStrategyConfig,
	AutonomousAttemptExecutionResult,
	BackoffStrategy,
	CandidateArbitrationResult,
	CandidateBranchEvaluation,
	CircuitBreakerConfig,
	CircuitBreakerState,
	CircuitBreakerStatus,
	CompletionGateResult,
	CriterionEvaluatorFn,
	CriterionScoreResult,
	DagExecutionReport,
	DiagnosticMicroPatch,
	DynamicGateCriteria,
	EvaluationAggregationPolicy,
	FlightEvent,
	FlightLog,
	GateCriteria,
	GateCriterionCategory,
	GateCriterionSeverity,
	GateNode,
	GatePhase,
	RemediationDirective,
	RemediationStrategyType,
} from "./tooling/extensions/policy/roadmap-completion-gate.js"
export {
	AttemptCompletionGateStrategy,
	AttemptFlightRecorder,
	ConsensusArbiter,
	CriterionScoreEvaluator,
	DiagnosticPatchSynthesizer,
	GatePipelineDag,
	RoadmapCompletionGate,
} from "./tooling/extensions/policy/roadmap-completion-gate.js"
export { PreflightToolSuite } from "./tooling/extensions/preflight_scanner/preflight-tool-suite.js"
export { ProcessOutputRingBuffer } from "./tooling/extensions/process/process-output-ring-buffer.js"
export { ProcessSecuritySandbox } from "./tooling/extensions/process/process-security-sandbox.js"
export { ProcessToolSuite } from "./tooling/extensions/process/process-tool-suite.js"
export { ProfileToolSuite } from "./tooling/extensions/profiles/profile-tool-suite.js"
export { ProgressStreamingEars, TerminalProgressRenderer } from "./tooling/extensions/progress/progress-ears.js"
export { DeterministicPromptCacher } from "./tooling/extensions/prompt/deterministic-prompt-cacher.js"
export { PromptCacheToolSuite } from "./tooling/extensions/prompt/prompt-cache-tool-suite.js"
export { DeterministicReasoningScrubber } from "./tooling/extensions/reasoning/deterministic-reasoning-scrubber.js"
export { ReasoningToolSuite } from "./tooling/extensions/reasoning/reasoning-tool-suite.js"
export { DeterministicSecretRedactor } from "./tooling/extensions/redaction/deterministic-secret-redactor.js"
export { SecretRedactionToolSuite } from "./tooling/extensions/redaction/secret-redaction-tool-suite.js"
export { ArgumentCoercer } from "./tooling/extensions/registry/argument-coercer.js"
export type {
	StreamingToolExecutorOptions,
	ToolExecutionPhase,
	ToolExecutionProgress,
} from "./tooling/extensions/registry/broccolidb-streaming-tool-executor.js"
export { BroccoliStreamingToolExecutor } from "./tooling/extensions/registry/broccolidb-streaming-tool-executor.js"
export { SkillsIngestor } from "./tooling/extensions/registry/skills-ingestor.js"
export type { ValidationResult } from "./tooling/extensions/registry/tool-call-schema-validator.js"
export { ToolCallSchemaValidator } from "./tooling/extensions/registry/tool-call-schema-validator.js"
export { ToolRegistry, ValidatingToolRegistry } from "./tooling/extensions/registry/tool-registry.js"
export { BackgroundReviewToolSuite } from "./tooling/extensions/review/background-review-tool-suite.js"
export { DeterministicReviewEvaluator } from "./tooling/extensions/review/deterministic-review-evaluator.js"
export { AuxiliaryRouterToolSuite } from "./tooling/extensions/router/auxiliary-router-tool-suite.js"
export { DeterministicAuxiliaryRouter } from "./tooling/extensions/router/deterministic-auxiliary-router.js"
export { RunbookToolSuite } from "./tooling/extensions/runbooks/runbook-tool-suite.js"
export { SchemaSanitizerToolSuite } from "./tooling/extensions/schema_sanitizer/schema-sanitizer-tool-suite.js"
export { DeterministicSessionSearchEngine } from "./tooling/extensions/search/deterministic-session-search-engine.js"
export { FtsQuerySanitizer } from "./tooling/extensions/search/fts-query-sanitizer.js"
export { SearchToolSuite } from "./tooling/extensions/search/search-tool-suite.js"
export { SelfRepoGuardToolSuite } from "./tooling/extensions/self_repo_guard/self-repo-guard-tool-suite.js"
export { SkillLinterToolSuite } from "./tooling/extensions/skill_linter/skill-linter-tool-suite.js"
export { AnchoredSkillMutator } from "./tooling/extensions/skills/anchored-skill-mutator.js"
export { DeterministicSkillTreeParser } from "./tooling/extensions/skills/deterministic-skill-tree-parser.js"
export { SkillCustomForgeEngine } from "./tooling/extensions/skills/skill-custom-forge-engine.js"
export { SkillDropVault } from "./tooling/extensions/skills/skill-drop-vault.js"
export {
	DEFAULT_SKILL_NOTIFICATION_PREFERENCES,
	SkillDesktopNotificationDispatcher,
} from "./tooling/extensions/skills/skill-notification-dispatcher.js"
export { SkillTreeToolSuite } from "./tooling/extensions/skills/skill-tree-tool-suite.js"
export { SkillsSyncToolSuite } from "./tooling/extensions/skills_sync/skills-sync-tool-suite.js"
export { DeterministicSkillsHub } from "./tooling/extensions/skills-hub/deterministic-skills-hub.js"
export { SkillsHubToolSuite } from "./tooling/extensions/skills-hub/skills-hub-tool-suite.js"
export { DeterministicSkinEngine } from "./tooling/extensions/skin/deterministic-skin-engine.js"
export { TerminalSkinToolSuite } from "./tooling/extensions/skin/terminal-skin-tool-suite.js"
export { AnchoredSoulMutator } from "./tooling/extensions/soul/anchored-soul-mutator.js"
export { DeterministicSoulParser } from "./tooling/extensions/soul/deterministic-soul-parser.js"
export { SoulCustomForgeEngine } from "./tooling/extensions/soul/soul-custom-forge-engine.js"
export { SoulDropVault } from "./tooling/extensions/soul/soul-drop-vault.js"
export { SoulErgonomicsEngine } from "./tooling/extensions/soul/soul-ergonomics-engine.js"
export { SoulToolSuite } from "./tooling/extensions/soul/soul-tool-suite.js"
export { SpeechNormalizerToolSuite } from "./tooling/extensions/speech_normalizer/speech-normalizer-tool-suite.js"
export { SpillVaultToolSuite } from "./tooling/extensions/spill_vault/spill-vault-tool-suite.js"
export { StealthBrowserToolSuite } from "./tooling/extensions/stealth_browser/stealth-browser-tool-suite.js"
export { StreamDiagToolSuite } from "./tooling/extensions/stream_diag/stream-diag-tool-suite.js"
export { StreamingScrubberToolSuite } from "./tooling/extensions/streaming_scrubber/streaming-scrubber-tool-suite.js"
export { SubdirHintsToolSuite } from "./tooling/extensions/subdir_hints/subdir-hints-tool-suite.js"
export type { ExecutionTraceEvent, ExecutionTraceEventKind } from "./tooling/extensions/telemetry/broccolidb-execution-trace.js"
export { BroccoliExecutionTraceRecorder } from "./tooling/extensions/telemetry/broccolidb-execution-trace.js"
export type { BufferSummaryOptions } from "./tooling/extensions/telemetry/broccolidb-output-buffer.js"
export { BroccoliCommandOutputBuffer } from "./tooling/extensions/telemetry/broccolidb-output-buffer.js"
export { Ears, ProtocolEars } from "./tooling/extensions/telemetry/ears.js"
export type { FetchResult } from "./tooling/extensions/telemetry/resilient-fetch-client.js"
export { ResilientFetchClient } from "./tooling/extensions/telemetry/resilient-fetch-client.js"
export type { SuppressionStats } from "./tooling/extensions/telemetry/stderr-guard.js"
export { StderrGuardFilter } from "./tooling/extensions/telemetry/stderr-guard.js"
export type { StreamChunkEvent } from "./tooling/extensions/telemetry/stream-event-formatter.js"
export { StreamEventFormatter } from "./tooling/extensions/telemetry/stream-event-formatter.js"
export type { ActiveSpan } from "./tooling/extensions/telemetry/telemetry-tracer.js"
export { TelemetryTracer } from "./tooling/extensions/telemetry/telemetry-tracer.js"
export { TerminalTextSanitizer } from "./tooling/extensions/telemetry/text-sanitizer.js"
export type { TimingMeasurement } from "./tooling/extensions/telemetry/timing-buffer.js"
export { MicrosecondTimingBuffer } from "./tooling/extensions/telemetry/timing-buffer.js"
export type { TTSRMeasurement } from "./tooling/extensions/telemetry/ttsr-coordinator.js"
export { TTSRCoordinator } from "./tooling/extensions/telemetry/ttsr-coordinator.js"
export { TerminalCleanerToolSuite } from "./tooling/extensions/terminal_cleaner/terminal-cleaner-tool-suite.js"
export { ThreadContextToolSuite } from "./tooling/extensions/thread_context/thread-context-tool-suite.js"
export { DeterministicThreatScanner } from "./tooling/extensions/threat/deterministic-threat-scanner.js"
export { ThreatFirewallToolSuite } from "./tooling/extensions/threat/threat-firewall-tool-suite.js"
export { TitleInsightsToolSuite } from "./tooling/extensions/title_insights/title-insights-tool-suite.js"
export { TranscriptionToolSuite } from "./tooling/extensions/transcription/transcription-tool-suite.js"
export { TurnRetryToolSuite } from "./tooling/extensions/turn_retry/turn-retry-tool-suite.js"
export { UrlSafetyToolSuite } from "./tooling/extensions/url_safety/url-safety-tool-suite.js"
export { V4aPatchToolSuite } from "./tooling/extensions/v4a_patch/v4a-patch-tool-suite.js"
export { DeterministicImageCodec } from "./tooling/extensions/vision/deterministic-image-codec.js"
export { MultimodalVisionToolSuite } from "./tooling/extensions/vision/multimodal-vision-tool-suite.js"
export { DeterministicAudioCodec } from "./tooling/extensions/voice/deterministic-audio-codec.js"
export { VoiceSpeechToolSuite } from "./tooling/extensions/voice/voice-speech-tool-suite.js"
export { WakeWordToolSuite } from "./tooling/extensions/wake_word/wake-word-tool-suite.js"
export { DeterministicWalletEngine } from "./tooling/extensions/wallet/deterministic-wallet-engine.js"
export { WalletToolSuite } from "./tooling/extensions/wallet/wallet-tool-suite.js"
export { DeterministicWebEngine } from "./tooling/extensions/web/deterministic-web-engine.js"
export { WebIntelligenceToolSuite } from "./tooling/extensions/web/web-intelligence-tool-suite.js"
export { WebsitePolicyToolSuite } from "./tooling/extensions/website_policy/website-policy-tool-suite.js"
export { WorktreeToolSuite } from "./tooling/extensions/worktree/worktree-tool-suite.js"
export { AcpDashboardModal } from "./tui/components/acp-dashboard-modal.js"
export {
	BackgroundReviewDashboardModal,
	type BackgroundReviewDashboardViewMode,
} from "./tui/components/background-review-dashboard-modal.js"
export { BatchDashboardModal, type BatchDashboardViewMode } from "./tui/components/batch-dashboard-modal.js"
export { BillingUsageDashboardModal, type BillingUsageDashboardViewMode } from "./tui/components/billing-usage-dashboard-modal.js"
export { CheckpointDashboardModal, type CheckpointDashboardViewMode } from "./tui/components/checkpoint-dashboard-modal.js"
export { ClarifyDashboardModal, type ClarifyDashboardViewMode } from "./tui/components/clarify-dashboard-modal.js"
export { CompressionDashboardModal, type CompressionDashboardViewMode } from "./tui/components/compression-dashboard-modal.js"
export { ComputerUseDashboardModal, type ComputerUseDashboardViewMode } from "./tui/components/computer-use-dashboard-modal.js"
export { CostDashboardModal, type CostDashboardViewMode } from "./tui/components/cost-dashboard-modal.js"
export { CronDashboardModal } from "./tui/components/cron-dashboard-modal.js"
export { DeadlineDashboardModal, type DeadlineDashboardViewMode } from "./tui/components/deadline-dashboard-modal.js"
export {
	DiagnosticDoctorDashboardModal,
	type DiagnosticDoctorDashboardViewMode,
} from "./tui/components/diagnostic-doctor-dashboard-modal.js"
export { EmailInboxModal, type EmailInboxViewMode } from "./tui/components/email-inbox-modal.js"
export { ExecutionDashboardModal, type ExecutionDashboardViewMode } from "./tui/components/execution-dashboard-modal.js"
export { GoalDashboardModal } from "./tui/components/goal-dashboard-modal.js"
export {
	HeredocTerminalDashboardModal,
	type HeredocTerminalDashboardViewMode,
} from "./tui/components/heredoc-terminal-dashboard-modal.js"
export {
	IdentityFederationDashboardModal,
	type IdentityFederationDashboardViewMode,
} from "./tui/components/identity-federation-dashboard-modal.js"
export { IntegrationsDashboardModal, type IntegrationsDashboardViewMode } from "./tui/components/integrations-dashboard-modal.js"
export { LocalEndpointDashboardModal } from "./tui/components/local-endpoint-dashboard-modal.js"
export { MemoryCuratorModal, type MemoryCuratorViewMode } from "./tui/components/memory-curator-modal.js"
export { OsvDashboardModal, type OsvDashboardViewMode } from "./tui/components/osv-dashboard-modal.js"
export {
	PatchMutationDashboardModal,
	type PatchMutationDashboardViewMode,
} from "./tui/components/patch-mutation-dashboard-modal.js"
export { PreflightDashboardModal, type PreflightDashboardViewMode } from "./tui/components/preflight-dashboard-modal.js"
export { ProfileDashboardModal, type ProfileDashboardViewMode } from "./tui/components/profile-dashboard-modal.js"
export { PromptCacheDashboardModal, type PromptCacheDashboardViewMode } from "./tui/components/prompt-cache-dashboard-modal.js"
export { RunbookDashboardModal, type RunbookDashboardViewMode } from "./tui/components/runbook-dashboard-modal.js"
export {
	SchemaSanitizerDashboardModal,
	type SchemaSanitizerDashboardViewMode,
} from "./tui/components/schema-sanitizer-dashboard-modal.js"
export {
	SelfRepoGuardDashboardModal,
	type SelfRepoGuardDashboardViewMode,
} from "./tui/components/self-repo-guard-dashboard-modal.js"
export {
	SessionArchiveDashboardModal,
	type SessionArchiveDashboardViewMode,
} from "./tui/components/session-archive-dashboard-modal.js"
export { SkillLinterDashboardModal, type SkillLinterDashboardViewMode } from "./tui/components/skill-linter-dashboard-modal.js"
export { SkillTreeModal, type SkillTreeModalViewMode } from "./tui/components/skill-tree-modal.js"
export { SoulDashboardModal, type SoulDashboardViewMode } from "./tui/components/soul-dashboard-modal.js"
export {
	StreamingScrubberDashboardModal,
	type StreamingScrubberDashboardViewMode,
} from "./tui/components/streaming-scrubber-dashboard-modal.js"
export { SubdirHintsDashboardModal, type SubdirHintsDashboardViewMode } from "./tui/components/subdir-hints-dashboard-modal.js"
export { SwarmDashboardModal } from "./tui/components/swarm-dashboard-modal.js"
export {
	TerminalCleanerDashboardModal,
	type TerminalCleanerDashboardViewMode,
} from "./tui/components/terminal-cleaner-dashboard-modal.js"
export {
	ThreadContextDashboardModal,
	type ThreadContextDashboardViewMode,
} from "./tui/components/thread-context-dashboard-modal.js"
export {
	TitleInsightsDashboardModal,
	type TitleInsightsDashboardViewMode,
} from "./tui/components/title-insights-dashboard-modal.js"
export {
	ToolDisclosureDashboardModal,
	type ToolDisclosureDashboardViewMode,
} from "./tui/components/tool-disclosure-dashboard-modal.js"
export {
	ToolExecutionGuardDashboardModal,
	type ToolExecutionGuardDashboardViewMode,
} from "./tui/components/tool-execution-guard-dashboard-modal.js"
export { TurnRetryDashboardModal, type TurnRetryDashboardViewMode } from "./tui/components/turn-retry-dashboard-modal.js"
export type { UrlSafetyDashboardViewMode } from "./tui/components/url-safety-dashboard-modal.js"
export { UrlSafetyDashboardModal } from "./tui/components/url-safety-dashboard-modal.js"
export {
	VerificationEvidenceDashboardModal,
	type VerificationEvidenceDashboardViewMode,
} from "./tui/components/verification-evidence-dashboard-modal.js"
export { WalletDashboardModal, type WalletDashboardViewMode } from "./tui/components/wallet-dashboard-modal.js"
export * as Tui from "./tui/tui-facade.js"

/**
 * Deterministic Game Engine Monolith Composition Root.
 * Models agent interactions as frame ticks (`tick()`), state transitions as immutable snapshots (`GameStateSnapshot`),
 * and provides frame-perfect state rewind and replay.
 */
export class LumiMonolith implements IAgentEngine {
	/** Complete, future-compatible factory composition. Named fields below remain compatibility aliases. */
	readonly components: Readonly<ReturnType<typeof MonolithFactory.createEngine>>
	readonly config: AgentConfig
	readonly sessionContext: SessionContext
	readonly sessionStore: PersistentSessionStore
	readonly sessionCompactor: SessionCompactor
	readonly sessionVfs: SessionVfs
	readonly sessionMemoryStore: SessionMemoryStore
	readonly stabilityDoctor: StabilityDoctor
	readonly snapcompactEngine: SnapcompactEngine
	readonly fileLockManager: FileLockManager
	readonly snapshotLruCache: LruCache<string, GameStateSnapshot>
	readonly gatewaySessionRegistry: GatewaySessionRegistry
	readonly snapshotStorageIndex: SnapshotStorageIndex
	readonly snowflakeIdGenerator: SnowflakeIdGenerator
	readonly systemDirectoryResolver: SystemDirectoryResolver
	readonly ringBuffer: FixedRingBuffer<string>
	readonly semverComparator: SemanticVersionComparator
	readonly gitIgnoreFilter: GitIgnoreFilter
	readonly treeWalker: WorkspaceTreeWalker
	readonly modelResolver: ModelResolver
	readonly modelCatalog: ModelCatalog
	readonly envKeyResolver: EnvironmentKeyResolver
	readonly imageModelRegistry: ImageModelRegistry
	readonly proxyGateway: LlmProxyGateway
	readonly reasoningEffortController: ReasoningEffortController
	readonly dynamicModelCache: DynamicModelCache
	readonly loopPhaseController: LoopPhaseController
	readonly budgetCalculator: ContextBudgetCalculator
	readonly tokenTruncator: TokenTruncator
	readonly templateEngine: PromptTemplateEngine
	readonly variableInjector: DynamicVariableInjector
	readonly connectionController: TransportConnectionController
	readonly resilientFetchClient: ResilientFetchClient
	readonly frontmatterParser: FrontmatterParser
	readonly filePeeker: BoundedFilePeeker
	readonly commandPathResolver: CommandPathResolver
	readonly textSanitizer: TerminalTextSanitizer
	readonly timingBuffer: MicrosecondTimingBuffer
	readonly tabSpacingNormalizer: TabSpacingNormalizer
	readonly schemaValidator: ToolCallSchemaValidator
	readonly argumentCoercer: ArgumentCoercer
	readonly batchAnchorer: BatchEditAnchorer
	readonly diffSynthesizer: DiffSynthesizer
	readonly masterBenchmarkOrchestrator: MasterBenchmarkOrchestrator
	readonly mcpHub: McpHub
	readonly ripgrepSearchService: RipgrepSearchService
	readonly urlContentFetcher: UrlContentFetcher
	readonly languageSyntaxParser: LanguageSyntaxParser
	readonly completionGate: RoadmapCompletionGate
	readonly checkpointDigest: RoadmapCheckpointDigest
	readonly clipboardBridge: NativeClipboardBridge
	readonly loopHarness: AgentLoopHarness
	readonly postmortemDiagnostic: PostmortemDiagnostic
	readonly processLifecycleManager: ProcessLifecycleManager
	readonly providerAttribution: ProviderAttributionComposer
	readonly stderrGuard: StderrGuardFilter
	readonly keybindingsController: KeybindingsController
	readonly httpDispatcher: HttpDispatcherOverlay
	readonly authStorageVault: AuthStorageVault
	readonly ttsrCoordinator: TTSRCoordinator
	readonly centennialPassMarker: CentennialPassMarker
	readonly systemHealthAggregator: SystemHealthAggregator

	readonly setupWizard: SetupWizard
	readonly slashRouter: AgentSlashRouter
	readonly mentionResolver: MentionResolver
	readonly swarmDispatcher: AgentSwarmDispatcher
	readonly intelligenceEngine: WorkspaceIntelligenceEngine
	readonly interactiveController: InteractiveModeController
	readonly permissionController: CommandPermissionController
	readonly commitGenerator: AgenticCommitGenerator
	readonly gatewayServer: MonolithGatewayServer
	readonly benchmarkEvaluator: MonolithBenchmarkEvaluator
	readonly telemetryTracer: TelemetryTracer
	readonly streamFormatter: StreamEventFormatter
	readonly eyes: AstPerceptionEyes
	readonly hands: AnchoredHands
	readonly ears: ProgressStreamingEars
	readonly skillsIngestor: SkillsIngestor
	readonly skillTreeParser: DeterministicSkillTreeParser
	readonly anchoredSkillMutator: AnchoredSkillMutator
	readonly skillTreeToolSuite: SkillTreeToolSuite
	readonly skillTreeSubstrate: BroccoliSkillTreeSubstrate
	readonly skillTreeSnapshotManager: SkillTreeSnapshotManager
	readonly deterministicSkillCurator: DeterministicSkillCurator
	readonly evolutionarySkillEngine: EvolutionarySkillTreeEngine
	readonly skillStrategyEngine: SkillStrategyEngine
	readonly skillTreePromptComposer: SkillTreePromptComposer
	readonly antiDegenerationGuard: AntiDegenerationGuard
	readonly deterministicSoulParser: DeterministicSoulParser
	readonly anchoredSoulMutator: AnchoredSoulMutator
	readonly soulToolSuite: SoulToolSuite
	readonly broccoliSoulSubstrate: BroccoliSoulSubstrate
	readonly soulSnapshotManager: SoulSnapshotManager
	readonly soulThreatGuard: SoulThreatGuard
	readonly soulPromptComposer: SoulPromptComposer
	readonly anchoredWorktreeManager: AnchoredWorktreeManager
	readonly subagentBudgetGovernor: SubagentBudgetGovernor
	readonly subagentLifecycleGuard: SubagentLifecycleGuard
	readonly subagentVfsBrancher: SubagentVfsBrancher
	readonly monolithSwarmDelegator: MonolithSwarmDelegator
	readonly swarmToolSuite: SwarmToolSuite
	readonly deterministicBlueprintCatalog: DeterministicBlueprintCatalog
	readonly anchoredCronJobManager: AnchoredCronJobManager
	readonly cronToolSuite: CronToolSuite
	readonly broccoliCronSubstrate: BroccoliCronSubstrate
	readonly cronSnapshotManager: CronSnapshotManager
	readonly cronLifecycleGuard: CronLifecycleGuard
	readonly monolithCronScheduler: MonolithCronScheduler
	readonly cdpNavigationGuard: CdpNavigationGuard
	readonly cdpDialogPolicyEngine: CdpDialogPolicyEngine
	readonly cdpDomSnapshotter: CdpDomSnapshotter
	readonly cdpProtocolClient: CdpProtocolClient
	readonly broccoliBrowserSubstrate: BroccoliBrowserSubstrate
	readonly browserSnapshotManager: BrowserSnapshotManager
	readonly cdpSupervisorEngine: CdpSupervisorEngine
	readonly cdpToolSuite: CdpToolSuite
	readonly broccoliCredentialSubstrate: BroccoliCredentialSubstrate
	readonly deterministicCredentialPool: DeterministicCredentialPool
	readonly credentialCircuitBreaker: CredentialCircuitBreaker
	readonly monolithCredentialManager: MonolithCredentialManager
	readonly credentialSnapshotManager: CredentialSnapshotManager
	readonly credentialToolSuite: CredentialToolSuite
	readonly telegramProtocolAdapter: TelegramProtocolAdapter
	readonly discordProtocolAdapter: DiscordProtocolAdapter
	readonly slackProtocolAdapter: SlackProtocolAdapter
	readonly webhookProtocolAdapter: WebhookProtocolAdapter
	readonly broccoliGatewaySubstrate: BroccoliGatewaySubstrate
	readonly gatewayDeliveryLedger: GatewayDeliveryLedger
	readonly gatewaySnapshotManager: GatewaySnapshotManager
	readonly gatewayDispatcherEngine: GatewayDispatcherEngine
	readonly deterministicGatewayEngine: DeterministicGatewayEngine
	readonly gatewaySupervisor: GatewaySupervisor
	readonly gatewayToolSuite: GatewayToolSuite
	readonly broccoliIntegrationsSubstrate: BroccoliIntegrationsSubstrate
	readonly integrationsSnapshotManager: IntegrationsSnapshotManager
	readonly deterministicIntegrationsEngine: DeterministicIntegrationsEngine
	readonly integrationsSupervisor: IntegrationsSupervisor
	readonly integrationsToolSuite: IntegrationsToolSuite
	readonly headTailBudgetGovernor: HeadTailBudgetGovernor
	readonly deterministicToolPruner: DeterministicToolPruner
	readonly broccoliCompressionSubstrate: BroccoliCompressionSubstrate
	readonly compressionSnapshotManager: CompressionSnapshotManager
	readonly trajectoryCompactorEngine: TrajectoryCompactorEngine
	readonly contextCompressionSupervisor: ContextCompressionSupervisor
	readonly compressionToolSuite: CompressionToolSuite
	readonly ftsQuerySanitizer: FtsQuerySanitizer
	readonly broccoliSearchSubstrate: BroccoliSearchSubstrate
	readonly searchSnapshotManager: SearchSnapshotManager
	readonly deterministicSessionSearchEngine: DeterministicSessionSearchEngine
	readonly searchToolSuite: SearchToolSuite
	readonly secretScrubber: SecretScrubber
	readonly localEnvironmentAdapter: LocalEnvironmentAdapter
	readonly dockerEnvironmentAdapter: DockerEnvironmentAdapter
	readonly broccoliEnvironmentSubstrate: BroccoliEnvironmentSubstrate
	readonly environmentSnapshotManager: EnvironmentSnapshotManager
	readonly environmentSupervisorEngine: EnvironmentSupervisorEngine
	readonly environmentToolSuite: EnvironmentToolSuite
	readonly jitteredBackoffGovernor: JitteredBackoffGovernor
	readonly deterministicErrorClassifier: DeterministicErrorClassifier
	readonly broccoliFaultSubstrate: BroccoliFaultSubstrate
	readonly faultSnapshotManager: FaultSnapshotManager
	readonly faultRecoverySupervisor: FaultRecoverySupervisor
	readonly faultDiagnosticToolSuite: FaultDiagnosticToolSuite
	readonly acpProtocolCodec: AcpProtocolCodec
	readonly acpPermissionGate: AcpPermissionGate
	readonly broccoliAcpSubstrate: BroccoliAcpSubstrate
	readonly acpSnapshotManager: AcpSnapshotManager
	readonly acpSpeculativeChangesetStager: AcpSpeculativeChangesetStager
	readonly acpFineGrainedHunkPatcher: AcpFineGrainedHunkPatcher
	readonly acpBridgeServer: AcpBridgeServer
	readonly acpToolSuite: AcpToolSuite
	readonly acpDashboardModal: AcpDashboardModal
	readonly mcpTransportCodec: McpTransportCodec
	readonly mcpSecurityScrubber: McpSecurityScrubber
	readonly broccoliMcpSubstrate: BroccoliMcpSubstrate
	readonly mcpSnapshotManager: McpSnapshotManager
	readonly mcpSupervisorEngine: McpSupervisorEngine
	readonly mcpClientToolSuite: McpClientToolSuite
	readonly processOutputRingBuffer: ProcessOutputRingBuffer
	readonly processSecuritySandbox: ProcessSecuritySandbox
	readonly broccoliProcessSubstrate: BroccoliProcessSubstrate
	readonly processSnapshotManager: ProcessSnapshotManager
	readonly processSupervisorEngine: ProcessSupervisorEngine
	readonly processToolSuite: ProcessToolSuite
	readonly securityRiskClassifier: SecurityRiskClassifier
	readonly approvalHashLedger: ApprovalHashLedger
	readonly broccoliArbiterSubstrate: BroccoliArbiterSubstrate
	readonly arbiterSnapshotManager: ArbiterSnapshotManager
	readonly interactiveSecurityArbiter: InteractiveSecurityArbiter
	readonly arbiterToolSuite: ArbiterToolSuite
	readonly semanticKnowledgeGraph: SemanticKnowledgeGraph
	readonly broccoliLearningSubstrate: BroccoliLearningSubstrate
	readonly learningSnapshotManager: LearningSnapshotManager
	readonly continuousLearningCurator: ContinuousLearningCurator
	readonly learningCuratorToolSuite: LearningCuratorToolSuite
	readonly deterministicPatchEngine: DeterministicPatchEngine
	readonly broccoliPatchSubstrate: BroccoliPatchSubstrate
	readonly patchSnapshotManager: PatchSnapshotManager
	readonly atomicMutationSupervisor: AtomicMutationSupervisor
	readonly fileMutationToolSuite: FileMutationToolSuite
	readonly deterministicLspEngine: DeterministicLspEngine
	readonly broccoliLspSubstrate: BroccoliLspSubstrate
	readonly lspSnapshotManager: LspSnapshotManager
	readonly semanticCodeSupervisor: SemanticCodeSupervisor
	readonly lspCodeIntelligenceToolSuite: LspCodeIntelligenceToolSuite
	readonly deterministicAudioCodec: DeterministicAudioCodec
	readonly broccoliVoiceSubstrate: BroccoliVoiceSubstrate
	readonly voiceSnapshotManager: VoiceSnapshotManager
	readonly voiceSpeechSupervisor: VoiceSpeechSupervisor
	readonly voiceSpeechToolSuite: VoiceSpeechToolSuite
	readonly deterministicImageCodec: DeterministicImageCodec
	readonly broccoliVisionSubstrate: BroccoliVisionSubstrate
	readonly visionSnapshotManager: VisionSnapshotManager
	readonly multimodalVisionSupervisor: MultimodalVisionSupervisor
	readonly multimodalVisionToolSuite: MultimodalVisionToolSuite
	readonly deterministicKanbanEngine: DeterministicKanbanEngine
	readonly broccoliKanbanSubstrate: BroccoliKanbanSubstrate
	readonly kanbanSnapshotManager: KanbanSnapshotManager
	readonly kanbanBoardSupervisor: KanbanBoardSupervisor
	readonly kanbanOrchestrationToolSuite: KanbanOrchestrationToolSuite
	readonly deterministicWebEngine: DeterministicWebEngine
	readonly broccoliWebSubstrate: BroccoliWebSubstrate
	readonly webSnapshotManager: WebSnapshotManager
	readonly webIntelligenceSupervisor: WebIntelligenceSupervisor
	readonly webIntelligenceToolSuite: WebIntelligenceToolSuite
	readonly deterministicCodeExecutor: DeterministicCodeExecutor
	readonly broccoliExecutionSubstrate: BroccoliExecutionSubstrate
	readonly executionSnapshotManager: ExecutionSnapshotManager
	readonly codeExecutionSupervisor: CodeExecutionSupervisor
	readonly codeExecutionToolSuite: CodeExecutionToolSuite
	readonly deterministicBatchEvaluator: DeterministicBatchEvaluator
	readonly broccoliBatchSubstrate: BroccoliBatchSubstrate
	readonly batchSnapshotManager: BatchSnapshotManager
	readonly batchEvaluationSupervisor: BatchEvaluationSupervisor
	readonly batchEvaluationToolSuite: BatchEvaluationToolSuite
	readonly deterministicClarifyEngine: DeterministicClarifyEngine
	readonly broccoliClarifySubstrate: BroccoliClarifySubstrate
	readonly clarifySnapshotManager: ClarifySnapshotManager
	readonly clarifyInquirySupervisor: ClarifyInquirySupervisor
	readonly clarifyInquiryToolSuite: ClarifyInquiryToolSuite
	readonly deterministicThreatScanner: DeterministicThreatScanner
	readonly broccoliThreatSubstrate: BroccoliThreatSubstrate
	readonly threatSnapshotManager: ThreatSnapshotManager
	readonly threatFirewallSupervisor: ThreatFirewallSupervisor
	readonly threatFirewallToolSuite: ThreatFirewallToolSuite
	readonly deterministicCasStore: DeterministicCasStore
	readonly broccoliCheckpointSubstrate: BroccoliCheckpointSubstrate
	readonly checkpointSnapshotManager: CheckpointSnapshotManager
	readonly checkpointKernelSupervisor: CheckpointKernelSupervisor
	readonly checkpointKernelToolSuite: CheckpointKernelToolSuite
	readonly deterministicDisplayDriver: DeterministicDisplayDriver
	readonly broccoliDisplaySubstrate: BroccoliDisplaySubstrate
	readonly displaySnapshotManager: DisplaySnapshotManager
	readonly computerUseSupervisor: ComputerUseSupervisor
	readonly computerUseToolSuite: ComputerUseToolSuite
	readonly deterministicSkillsHub: DeterministicSkillsHub
	readonly broccoliSkillsHubSubstrate: BroccoliSkillsHubSubstrate
	readonly skillsHubSnapshotManager: SkillsHubSnapshotManager
	readonly skillsHubSupervisor: SkillsHubSupervisor
	readonly skillsHubToolSuite: SkillsHubToolSuite
	readonly deterministicCostGovernor: DeterministicCostGovernor
	readonly broccoliCostSubstrate: BroccoliCostSubstrate
	readonly costSnapshotManager: CostSnapshotManager
	readonly costGovernanceSupervisor: CostGovernanceSupervisor
	readonly costGovernanceToolSuite: CostGovernanceToolSuite
	readonly deterministicToolDiscloser: DeterministicToolDiscloser
	readonly broccoliDisclosureSubstrate: BroccoliDisclosureSubstrate
	readonly toolDisclosureSnapshotManager: ToolDisclosureSnapshotManager
	readonly toolDisclosureSupervisor: ToolDisclosureSupervisor
	readonly toolDisclosureToolSuite: ToolDisclosureToolSuite
	readonly deterministicEvidenceLedger: DeterministicEvidenceLedger
	readonly broccoliEvidenceSubstrate: BroccoliEvidenceSubstrate
	readonly evidenceSnapshotManager: EvidenceSnapshotManager
	readonly verificationEvidenceSupervisor: VerificationEvidenceSupervisor
	readonly verificationEvidenceToolSuite: VerificationEvidenceToolSuite
	readonly deterministicPromptCacher: DeterministicPromptCacher
	readonly broccoliPromptCacheSubstrate: BroccoliPromptCacheSubstrate
	readonly promptCacheSnapshotManager: PromptCacheSnapshotManager
	readonly promptCacheSupervisor: PromptCacheSupervisor
	readonly promptCacheToolSuite: PromptCacheToolSuite
	readonly deterministicToolSegmenter: DeterministicToolSegmenter
	readonly broccoliExecutionGuardSubstrate: BroccoliExecutionGuardSubstrate
	readonly executionGuardSnapshotManager: ExecutionGuardSnapshotManager
	readonly toolExecutionGuardSupervisor: ToolExecutionGuardSupervisor
	readonly toolExecutionGuardToolSuite: ToolExecutionGuardToolSuite
	readonly deterministicSecretRedactor: DeterministicSecretRedactor
	readonly broccoliRedactionSubstrate: BroccoliRedactionSubstrate
	readonly redactionSnapshotManager: RedactionSnapshotManager
	readonly secretRedactionSupervisor: SecretRedactionSupervisor
	readonly secretRedactionToolSuite: SecretRedactionToolSuite
	readonly deterministicReviewEvaluator: DeterministicReviewEvaluator
	readonly broccoliReviewSubstrate: BroccoliReviewSubstrate
	readonly reviewSnapshotManager: ReviewSnapshotManager
	readonly backgroundReviewSupervisor: BackgroundReviewSupervisor
	readonly backgroundReviewToolSuite: BackgroundReviewToolSuite
	readonly deterministicDiagnosticDoctor: DeterministicDiagnosticDoctor
	readonly broccoliDoctorSubstrate: BroccoliDoctorSubstrate
	readonly doctorSnapshotManager: DoctorSnapshotManager
	readonly diagnosticDoctorSupervisor: DiagnosticDoctorSupervisor
	readonly diagnosticDoctorToolSuite: DiagnosticDoctorToolSuite
	readonly deterministicAuthFederator: DeterministicAuthFederator
	readonly broccoliAuthSubstrate: BroccoliAuthSubstrate
	readonly authSnapshotManager: AuthSnapshotManager
	readonly identityFederationSupervisor: IdentityFederationSupervisor
	readonly identityFederationToolSuite: IdentityFederationToolSuite
	readonly deterministicSessionArchiver: DeterministicSessionArchiver
	readonly broccoliArchiveSubstrate: BroccoliArchiveSubstrate
	readonly archiveSnapshotManager: ArchiveSnapshotManager
	readonly sessionArchiveSupervisor: SessionArchiveSupervisor
	readonly sessionArchiveToolSuite: SessionArchiveToolSuite
	readonly deterministicSkinEngine: DeterministicSkinEngine
	readonly broccoliSkinSubstrate: BroccoliSkinSubstrate
	readonly skinSnapshotManager: SkinSnapshotManager
	readonly terminalSkinSupervisor: TerminalSkinSupervisor
	readonly terminalSkinToolSuite: TerminalSkinToolSuite
	readonly deterministicAuxiliaryRouter: DeterministicAuxiliaryRouter
	readonly broccoliAuxiliarySubstrate: BroccoliAuxiliarySubstrate
	readonly auxiliarySnapshotManager: AuxiliarySnapshotManager
	readonly auxiliaryRouterSupervisor: AuxiliaryRouterSupervisor
	readonly auxiliaryRouterToolSuite: AuxiliaryRouterToolSuite
	readonly deterministicReasoningScrubber: DeterministicReasoningScrubber
	readonly broccoliReasoningSubstrate: BroccoliReasoningSubstrate
	readonly reasoningSnapshotManager: ReasoningSnapshotManager
	readonly reasoningSupervisor: ReasoningSupervisor
	readonly reasoningToolSuite: ReasoningToolSuite
	readonly deterministicFuzzyMatcher: DeterministicFuzzyMatcher
	readonly broccoliFuzzySubstrate: BroccoliFuzzySubstrate
	readonly fuzzySnapshotManager: FuzzySnapshotManager
	readonly fuzzyMatcherSupervisor: FuzzyMatcherSupervisor
	readonly fuzzyMatcherToolSuite: FuzzyMatcherToolSuite
	readonly deterministicTitleGenerator: DeterministicTitleGenerator
	readonly conversationInsightsEngine: ConversationInsightsEngine
	readonly titleInsightsSupervisor: TitleInsightsSupervisor
	readonly broccoliTitleInsightsSubstrate: BroccoliTitleInsightsSubstrate
	readonly titleInsightsSnapshotManager: TitleInsightsSnapshotManager
	readonly titleInsightsToolSuite: TitleInsightsToolSuite
	readonly deterministicHeredocSanitizer: DeterministicHeredocSanitizer
	readonly terminalDiagnosticsEngine: TerminalDiagnosticsEngine
	readonly heredocTerminalSupervisor: HeredocTerminalSupervisor
	readonly broccoliHeredocTerminalSubstrate: BroccoliHeredocTerminalSubstrate
	readonly heredocTerminalSnapshotManager: HeredocTerminalSnapshotManager
	readonly heredocTerminalToolSuite: HeredocTerminalToolSuite
	readonly deterministicStealthBrowser: DeterministicStealthBrowser
	readonly stealthBrowserSupervisor: StealthBrowserSupervisor
	readonly broccoliStealthBrowserSubstrate: BroccoliStealthBrowserSubstrate
	readonly stealthBrowserSnapshotManager: StealthBrowserSnapshotManager
	readonly stealthBrowserToolSuite: StealthBrowserToolSuite
	readonly deterministicSkillsSyncClient: DeterministicSkillsSyncClient
	readonly skillsSyncSupervisor: SkillsSyncSupervisor
	readonly broccoliSkillsSyncSubstrate: BroccoliSkillsSyncSubstrate
	readonly skillsSyncSnapshotManager: SkillsSyncSnapshotManager
	readonly skillsSyncToolSuite: SkillsSyncToolSuite
	readonly deterministicPreflightScanner: DeterministicPreflightScanner
	readonly preflightScannerSupervisor: PreflightScannerSupervisor
	readonly broccoliPreflightSubstrate: BroccoliPreflightSubstrate
	readonly preflightSnapshotManager: PreflightSnapshotManager
	readonly preflightToolSuite: PreflightToolSuite
	readonly deterministicAudioSniffer: DeterministicAudioSniffer
	readonly audioContainerSupervisor: AudioContainerSupervisor
	readonly broccoliAudioContainerSubstrate: BroccoliAudioContainerSubstrate
	readonly audioContainerSnapshotManager: AudioContainerSnapshotManager
	readonly audioContainerToolSuite: AudioContainerToolSuite
	readonly deterministicSpeechTextNormalizer: DeterministicSpeechTextNormalizer
	readonly speechNormalizerSupervisor: SpeechNormalizerSupervisor
	readonly broccoliSpeechNormalizerSubstrate: BroccoliSpeechNormalizerSubstrate
	readonly speechNormalizerSnapshotManager: SpeechNormalizerSnapshotManager
	readonly speechNormalizerToolSuite: SpeechNormalizerToolSuite
	readonly deterministicDocExtractor: DeterministicDocExtractor
	readonly docExtractorSupervisor: DocExtractorSupervisor
	readonly broccoliDocExtractorSubstrate: BroccoliDocExtractorSubstrate
	readonly docExtractorSnapshotManager: DocExtractorSnapshotManager
	readonly docExtractorToolSuite: DocExtractorToolSuite
	readonly deterministicSpillVault: DeterministicSpillVault
	readonly spillVaultSupervisor: SpillVaultSupervisor
	readonly broccoliSpillVaultSubstrate: BroccoliSpillVaultSubstrate
	readonly spillVaultSnapshotManager: SpillVaultSnapshotManager
	readonly spillVaultToolSuite: SpillVaultToolSuite
	readonly deterministicUrlSafety: DeterministicUrlSafety
	readonly urlSafetySupervisor: UrlSafetySupervisor
	readonly broccoliUrlSafetySubstrate: BroccoliUrlSafetySubstrate
	readonly urlSafetySnapshotManager: UrlSafetySnapshotManager
	readonly urlSafetyToolSuite: UrlSafetyToolSuite
	readonly deterministicV4aPatch: DeterministicV4aPatch
	readonly v4aPatchSupervisor: V4aPatchSupervisor
	readonly broccoliV4aPatchSubstrate: BroccoliV4aPatchSubstrate
	readonly v4aPatchSnapshotManager: V4aPatchSnapshotManager
	readonly v4aPatchToolSuite: V4aPatchToolSuite
	readonly deterministicWebsitePolicy: DeterministicWebsitePolicy
	readonly websitePolicySupervisor: WebsitePolicySupervisor
	readonly broccoliWebsitePolicySubstrate: BroccoliWebsitePolicySubstrate
	readonly websitePolicySnapshotManager: WebsitePolicySnapshotManager
	readonly websitePolicyToolSuite: WebsitePolicyToolSuite
	readonly deterministicWakeWord: DeterministicWakeWord
	readonly wakeWordSupervisor: WakeWordSupervisor
	readonly broccoliWakeWordSubstrate: BroccoliWakeWordSubstrate
	readonly wakeWordSnapshotManager: WakeWordSnapshotManager
	readonly wakeWordToolSuite: WakeWordToolSuite
	readonly deterministicMediaResolver: DeterministicMediaResolver
	readonly mediaSourceSupervisor: MediaSourceSupervisor
	readonly broccoliMediaSourceSubstrate: BroccoliMediaSourceSubstrate
	readonly mediaSourceSnapshotManager: MediaSourceSnapshotManager
	readonly mediaSourceToolSuite: MediaSourceToolSuite
	readonly deterministicGitWorktree: DeterministicGitWorktree
	readonly worktreeSupervisor: WorktreeSupervisor
	readonly broccoliWorktreeSubstrate: BroccoliWorktreeSubstrate
	readonly worktreeSnapshotManager: WorktreeSnapshotManager
	readonly worktreeToolSuite: WorktreeToolSuite
	readonly deterministicSpeechTranscriber: DeterministicSpeechTranscriber
	readonly transcriptionSupervisor: TranscriptionSupervisor
	readonly broccoliTranscriptionSubstrate: BroccoliTranscriptionSubstrate
	readonly transcriptionSnapshotManager: TranscriptionSnapshotManager
	readonly transcriptionToolSuite: TranscriptionToolSuite
	readonly deterministicDeadlineEngine: DeterministicDeadlineEngine
	readonly deadlineSupervisor: DeadlineSupervisor
	readonly broccoliDeadlineSubstrate: BroccoliDeadlineSubstrate
	readonly deadlineSnapshotManager: DeadlineSnapshotManager
	readonly deadlineToolSuite: DeadlineToolSuite
	readonly deterministicFileSafetyGuard: DeterministicFileSafetyGuard
	readonly fileSafetySupervisor: FileSafetySupervisor
	readonly broccoliFileSafetySubstrate: BroccoliFileSafetySubstrate
	readonly fileSafetySnapshotManager: FileSafetySnapshotManager
	readonly fileSafetyToolSuite: FileSafetyToolSuite
	readonly deterministicContextBreakdownEngine: DeterministicContextBreakdownEngine
	readonly contextBreakdownSupervisor: ContextBreakdownSupervisor
	readonly broccoliContextBreakdownSubstrate: BroccoliContextBreakdownSubstrate
	readonly contextBreakdownSnapshotManager: ContextBreakdownSnapshotManager
	readonly contextBreakdownToolSuite: ContextBreakdownToolSuite
	readonly deterministicOsvParser: DeterministicOsvParser
	readonly osvScannerSupervisor: OsvScannerSupervisor
	readonly broccoliOsvSubstrate: BroccoliOsvSubstrate
	readonly osvScannerSnapshotManager: OsvScannerSnapshotManager
	readonly osvScannerToolSuite: OsvScannerToolSuite
	readonly deterministicSubdirHintEngine: DeterministicSubdirHintEngine
	readonly subdirHintsSupervisor: SubdirHintsSupervisor
	readonly broccoliSubdirHintsSubstrate: BroccoliSubdirHintsSubstrate
	readonly subdirHintsSnapshotManager: SubdirHintsSnapshotManager
	readonly subdirHintsToolSuite: SubdirHintsToolSuite
	readonly deterministicStreamDiagEngine: DeterministicStreamDiagEngine
	readonly streamDiagSupervisor: StreamDiagSupervisor
	readonly broccoliStreamDiagSubstrate: BroccoliStreamDiagSubstrate
	readonly streamDiagSnapshotManager: StreamDiagSnapshotManager
	readonly streamDiagToolSuite: StreamDiagToolSuite
	readonly deterministicTurnRetryEngine: DeterministicTurnRetryEngine
	readonly turnRetrySupervisor: TurnRetrySupervisor
	readonly broccoliTurnRetrySubstrate: BroccoliTurnRetrySubstrate
	readonly turnRetrySnapshotManager: TurnRetrySnapshotManager
	readonly turnRetryToolSuite: TurnRetryToolSuite
	readonly deterministicBillingUsageEngine: DeterministicBillingUsageEngine
	readonly billingUsageSupervisor: BillingUsageSupervisor
	readonly broccoliBillingUsageSubstrate: BroccoliBillingUsageSubstrate
	readonly billingUsageSnapshotManager: BillingUsageSnapshotManager
	readonly billingUsageToolSuite: BillingUsageToolSuite
	readonly deterministicThreadContextEngine: DeterministicThreadContextEngine
	readonly threadContextSupervisor: ThreadContextSupervisor
	readonly broccoliThreadContextSubstrate: BroccoliThreadContextSubstrate
	readonly threadContextSnapshotManager: ThreadContextSnapshotManager
	readonly threadContextToolSuite: ThreadContextToolSuite
	readonly deterministicEnvProbeEngine: DeterministicEnvProbeEngine
	readonly envProbeSupervisor: EnvProbeSupervisor
	readonly broccoliEnvProbeSubstrate: BroccoliEnvProbeSubstrate
	readonly envProbeSnapshotManager: EnvProbeSnapshotManager
	readonly envProbeToolSuite: EnvProbeToolSuite
	readonly deterministicSkillLinterEngine: DeterministicSkillLinterEngine
	readonly skillLinterSupervisor: SkillLinterSupervisor
	readonly broccoliSkillLinterSubstrate: BroccoliSkillLinterSubstrate
	readonly skillLinterSnapshotManager: SkillLinterSnapshotManager
	readonly skillLinterToolSuite: SkillLinterToolSuite
	readonly deterministicTerminalCleanerEngine: DeterministicTerminalCleanerEngine
	readonly terminalCleanerSupervisor: TerminalCleanerSupervisor
	readonly broccoliTerminalCleanerSubstrate: BroccoliTerminalCleanerSubstrate
	readonly terminalCleanerSnapshotManager: TerminalCleanerSnapshotManager
	readonly terminalCleanerToolSuite: TerminalCleanerToolSuite
	readonly deterministicStreamingScrubberEngine: DeterministicStreamingScrubberEngine
	readonly streamingScrubberSupervisor: StreamingScrubberSupervisor
	readonly broccoliStreamingScrubberSubstrate: BroccoliStreamingScrubberSubstrate
	readonly streamingScrubberSnapshotManager: StreamingScrubberSnapshotManager
	readonly streamingScrubberToolSuite: StreamingScrubberToolSuite
	readonly deterministicSelfRepoGuardEngine: DeterministicSelfRepoGuardEngine
	readonly selfRepoGuardSupervisor: SelfRepoGuardSupervisor
	readonly broccoliSelfRepoGuardSubstrate: BroccoliSelfRepoGuardSubstrate
	readonly selfRepoGuardSnapshotManager: SelfRepoGuardSnapshotManager
	readonly selfRepoGuardToolSuite: SelfRepoGuardToolSuite
	readonly deterministicSchemaSanitizerEngine: DeterministicSchemaSanitizerEngine
	readonly schemaSanitizerSupervisor: SchemaSanitizerSupervisor
	readonly broccoliSchemaSanitizerSubstrate: BroccoliSchemaSanitizerSubstrate
	readonly schemaSanitizerSnapshotManager: SchemaSanitizerSnapshotManager
	readonly schemaSanitizerToolSuite: SchemaSanitizerToolSuite
	readonly deterministicNousPortalEngine: DeterministicNousPortalEngine
	readonly nousPortalSupervisor: NousPortalSupervisor
	readonly broccoliNousPortalSubstrate: BroccoliNousPortalSubstrate
	readonly nousPortalSnapshotManager: NousPortalSnapshotManager
	readonly nousPortalToolSuite: NousPortalToolSuite
	readonly deterministicGoalEngine: DeterministicGoalEngine
	readonly goalSupervisor: GoalSupervisor
	readonly broccoliGoalSubstrate: BroccoliGoalSubstrate
	readonly goalSnapshotManager: GoalSnapshotManager
	readonly goalToolSuite: GoalToolSuite
	readonly deterministicProfileEngine: DeterministicProfileEngine
	readonly profileSupervisor: ProfileSupervisor
	readonly broccoliProfileSubstrate: BroccoliProfileSubstrate
	readonly profileSnapshotManager: ProfileSnapshotManager
	readonly profileToolSuite: ProfileToolSuite
	readonly databaseKernel: BroccoliDatabaseKernel
	readonly broccoliConnectionPool: BroccoliConnectionPool
	readonly broccoliLockAuthority: BroccoliLockAuthority
	readonly broccoliQueryOptimizer: BroccoliQueryOptimizer
	readonly broccoliMvccEngine: BroccoliMvccEngine
	readonly broccoliSparseIndexEngine: BroccoliSparseIndexEngine
	readonly broccoliCdcStream: BroccoliCdcStream
	readonly broccoliVectorEngine: BroccoliVectorEngine
	readonly broccoliInvertedIndexEngine: BroccoliInvertedIndexEngine
	readonly broccoliTwoPhaseCommitCoordinator: BroccoliTwoPhaseCommitCoordinator
	readonly broccoliBufferPoolManager: BroccoliBufferPoolManager
	readonly broccoliLsmStore: BroccoliLsmStore
	readonly broccoliRaftConsensusEngine: BroccoliRaftConsensusEngine
	readonly broccoliAdaptivePlanCache: BroccoliAdaptivePlanCache
	readonly broccoliSagaOrchestrator: BroccoliSagaOrchestrator
	readonly broccoliTieredKvCache: BroccoliTieredKvCache
	readonly broccoliVectorAnnEngine: BroccoliVectorAnnEngine
	readonly broccoliConsistentHashRing: BroccoliConsistentHashRing
	readonly broccoliTimeSeriesRollupEngine: BroccoliTimeSeriesRollupEngine
	readonly broccoliBTreeIndexEngine: BroccoliBTreeIndexEngine
	readonly broccoliDeadlockDetector: BroccoliDeadlockDetector
	readonly broccoliMaterializedViewEngine: BroccoliMaterializedViewEngine
	readonly databaseToolSuite: DatabaseToolSuite
	readonly deterministicWalletEngine: DeterministicWalletEngine
	readonly walletSupervisor: WalletSupervisor
	readonly broccoliWalletSubstrate: BroccoliWalletSubstrate
	readonly walletSnapshotManager: WalletSnapshotManager
	readonly walletToolSuite: WalletToolSuite
	readonly deterministicEmailEngine: DeterministicEmailEngine
	readonly emailSupervisor: EmailSupervisor
	readonly broccoliEmailSubstrate: BroccoliEmailSubstrate
	readonly emailSnapshotManager: EmailSnapshotManager
	readonly emailToolSuite: EmailToolSuite
	readonly deterministicOtlpEngine: DeterministicOtlpEngine
	readonly otlpSupervisor: OtlpSupervisor
	readonly broccoliOtlpSubstrate: BroccoliOtlpSubstrate
	readonly otlpSnapshotManager: OtlpSnapshotManager
	readonly otlpToolSuite: OtlpToolSuite
	readonly deterministicAcpEngine: DeterministicAcpEngine
	readonly acpSupervisor: AcpSupervisor
	readonly deterministicDaemonEngine: DeterministicDaemonEngine
	readonly daemonSupervisor: DaemonSupervisor
	readonly broccoliDaemonSubstrate: BroccoliDaemonSubstrate
	readonly daemonSnapshotManager: DaemonSnapshotManager
	readonly daemonToolSuite: DaemonToolSuite
	readonly broccoliRunbookSubstrate: BroccoliRunbookSubstrate
	readonly runbookSupervisor: RunbookSupervisor
	readonly runbookToolSuite: RunbookToolSuite
	readonly broccoliAdversarialSubstrate: BroccoliAdversarialSubstrate
	readonly adversarialScrutinySupervisor: AdversarialScrutinySupervisor
	readonly adversarialHumanizer: AdversarialHumanizer
	readonly adversarialToolSuite: AdversarialToolSuite
	readonly toolRegistry: ValidatingToolRegistry
	readonly promptComposer: PromptComposer
	readonly agentEngine: AgentEngine

	constructor(options: MonolithFactoryOptions = {}) {
		const components = MonolithFactory.createEngine(options)
		this.components = components
		this.config = components.config
		this.sessionContext = components.sessionContext
		this.sessionStore = components.sessionStore
		this.sessionCompactor = components.sessionCompactor
		this.sessionVfs = components.sessionVfs
		this.sessionMemoryStore = components.sessionMemoryStore
		this.stabilityDoctor = components.stabilityDoctor
		this.snapcompactEngine = components.snapcompactEngine
		this.fileLockManager = components.fileLockManager
		this.snapshotLruCache = components.snapshotLruCache
		this.gatewaySessionRegistry = components.gatewaySessionRegistry
		this.snapshotStorageIndex = components.snapshotStorageIndex
		this.snowflakeIdGenerator = components.snowflakeIdGenerator
		this.systemDirectoryResolver = components.systemDirectoryResolver
		this.ringBuffer = components.ringBuffer
		this.semverComparator = components.semverComparator
		this.gitIgnoreFilter = components.gitIgnoreFilter
		this.treeWalker = components.treeWalker
		this.modelResolver = components.modelResolver
		this.modelCatalog = components.modelCatalog
		this.envKeyResolver = components.envKeyResolver
		this.imageModelRegistry = components.imageModelRegistry
		this.proxyGateway = components.proxyGateway
		this.reasoningEffortController = components.reasoningEffortController
		this.dynamicModelCache = components.dynamicModelCache
		this.loopPhaseController = components.loopPhaseController
		this.budgetCalculator = components.budgetCalculator
		this.tokenTruncator = components.tokenTruncator
		this.templateEngine = components.templateEngine
		this.variableInjector = components.variableInjector
		this.connectionController = components.connectionController
		this.resilientFetchClient = components.resilientFetchClient
		this.frontmatterParser = components.frontmatterParser
		this.filePeeker = components.filePeeker
		this.commandPathResolver = components.commandPathResolver
		this.textSanitizer = components.textSanitizer
		this.timingBuffer = components.timingBuffer
		this.tabSpacingNormalizer = components.tabSpacingNormalizer
		this.schemaValidator = components.schemaValidator
		this.argumentCoercer = components.argumentCoercer
		this.batchAnchorer = components.batchAnchorer
		this.diffSynthesizer = components.diffSynthesizer
		this.masterBenchmarkOrchestrator = components.masterBenchmarkOrchestrator
		this.mcpHub = components.mcpHub
		this.ripgrepSearchService = components.ripgrepSearchService
		this.urlContentFetcher = components.urlContentFetcher
		this.languageSyntaxParser = components.languageSyntaxParser
		this.completionGate = components.completionGate
		this.checkpointDigest = components.checkpointDigest
		this.clipboardBridge = components.clipboardBridge
		this.loopHarness = components.loopHarness
		this.postmortemDiagnostic = components.postmortemDiagnostic
		this.processLifecycleManager = components.processLifecycleManager
		this.providerAttribution = components.providerAttribution
		this.stderrGuard = components.stderrGuard
		this.keybindingsController = components.keybindingsController
		this.httpDispatcher = components.httpDispatcher
		this.authStorageVault = components.authStorageVault
		this.ttsrCoordinator = components.ttsrCoordinator
		this.centennialPassMarker = components.centennialPassMarker
		this.systemHealthAggregator = components.systemHealthAggregator

		this.setupWizard = components.setupWizard
		this.slashRouter = components.slashRouter
		this.mentionResolver = components.mentionResolver
		this.swarmDispatcher = components.swarmDispatcher
		this.intelligenceEngine = components.intelligenceEngine
		this.interactiveController = components.interactiveController
		this.permissionController = components.permissionController
		this.commitGenerator = components.commitGenerator
		this.gatewayServer = components.gatewayServer
		this.benchmarkEvaluator = components.benchmarkEvaluator
		this.telemetryTracer = components.telemetryTracer
		this.streamFormatter = components.streamFormatter
		this.eyes = components.eyes
		this.hands = components.hands
		this.ears = components.ears
		this.skillsIngestor = components.skillsIngestor
		this.skillTreeParser = components.skillTreeParser
		this.anchoredSkillMutator = components.anchoredSkillMutator
		this.skillTreeToolSuite = components.skillTreeToolSuite
		this.skillTreeSubstrate = components.skillTreeSubstrate
		this.skillTreeSnapshotManager = components.skillTreeSnapshotManager
		this.deterministicSkillCurator = components.deterministicSkillCurator
		this.evolutionarySkillEngine = components.evolutionarySkillEngine
		this.skillStrategyEngine = components.skillStrategyEngine
		this.skillTreePromptComposer = components.skillTreePromptComposer
		this.antiDegenerationGuard = components.antiDegenerationGuard
		this.deterministicSoulParser = components.deterministicSoulParser
		this.anchoredSoulMutator = components.anchoredSoulMutator
		this.soulToolSuite = components.soulToolSuite
		this.broccoliSoulSubstrate = components.broccoliSoulSubstrate
		this.soulSnapshotManager = components.soulSnapshotManager
		this.soulThreatGuard = components.soulThreatGuard
		this.soulPromptComposer = components.soulPromptComposer
		this.anchoredWorktreeManager = components.anchoredWorktreeManager
		this.subagentBudgetGovernor = components.subagentBudgetGovernor
		this.subagentLifecycleGuard = components.subagentLifecycleGuard
		this.subagentVfsBrancher = components.subagentVfsBrancher
		this.monolithSwarmDelegator = components.monolithSwarmDelegator
		this.swarmToolSuite = components.swarmToolSuite
		this.deterministicBlueprintCatalog = components.deterministicBlueprintCatalog
		this.anchoredCronJobManager = components.anchoredCronJobManager
		this.cronToolSuite = components.cronToolSuite
		this.broccoliCronSubstrate = components.broccoliCronSubstrate
		this.cronSnapshotManager = components.cronSnapshotManager
		this.cronLifecycleGuard = components.cronLifecycleGuard
		this.monolithCronScheduler = components.monolithCronScheduler
		this.cdpNavigationGuard = components.cdpNavigationGuard
		this.cdpDialogPolicyEngine = components.cdpDialogPolicyEngine
		this.cdpDomSnapshotter = components.cdpDomSnapshotter
		this.cdpProtocolClient = components.cdpProtocolClient
		this.broccoliBrowserSubstrate = components.broccoliBrowserSubstrate
		this.browserSnapshotManager = components.browserSnapshotManager
		this.cdpSupervisorEngine = components.cdpSupervisorEngine
		this.cdpToolSuite = components.cdpToolSuite
		this.broccoliCredentialSubstrate = components.broccoliCredentialSubstrate
		this.deterministicCredentialPool = components.deterministicCredentialPool
		this.credentialCircuitBreaker = components.credentialCircuitBreaker
		this.monolithCredentialManager = components.monolithCredentialManager
		this.credentialSnapshotManager = components.credentialSnapshotManager
		this.credentialToolSuite = components.credentialToolSuite
		this.telegramProtocolAdapter = components.telegramProtocolAdapter
		this.discordProtocolAdapter = components.discordProtocolAdapter
		this.slackProtocolAdapter = components.slackProtocolAdapter
		this.webhookProtocolAdapter = components.webhookProtocolAdapter
		this.broccoliGatewaySubstrate = components.broccoliGatewaySubstrate
		this.gatewayDeliveryLedger = components.gatewayDeliveryLedger
		this.gatewaySnapshotManager = components.gatewaySnapshotManager
		this.gatewayDispatcherEngine = components.gatewayDispatcherEngine
		this.deterministicGatewayEngine = components.deterministicGatewayEngine
		this.gatewaySupervisor = components.gatewaySupervisor
		this.gatewayToolSuite = components.gatewayToolSuite
		this.broccoliIntegrationsSubstrate = components.broccoliIntegrationsSubstrate
		this.integrationsSnapshotManager = components.integrationsSnapshotManager
		this.deterministicIntegrationsEngine = components.deterministicIntegrationsEngine
		this.integrationsSupervisor = components.integrationsSupervisor
		this.integrationsToolSuite = components.integrationsToolSuite
		this.headTailBudgetGovernor = components.headTailBudgetGovernor
		this.deterministicToolPruner = components.deterministicToolPruner
		this.broccoliCompressionSubstrate = components.broccoliCompressionSubstrate
		this.compressionSnapshotManager = components.compressionSnapshotManager
		this.trajectoryCompactorEngine = components.trajectoryCompactorEngine
		this.contextCompressionSupervisor = components.contextCompressionSupervisor
		this.compressionToolSuite = components.compressionToolSuite
		this.ftsQuerySanitizer = components.ftsQuerySanitizer
		this.broccoliSearchSubstrate = components.broccoliSearchSubstrate
		this.searchSnapshotManager = components.searchSnapshotManager
		this.deterministicSessionSearchEngine = components.deterministicSessionSearchEngine
		this.searchToolSuite = components.searchToolSuite
		this.secretScrubber = components.secretScrubber
		this.localEnvironmentAdapter = components.localEnvironmentAdapter
		this.dockerEnvironmentAdapter = components.dockerEnvironmentAdapter
		this.broccoliEnvironmentSubstrate = components.broccoliEnvironmentSubstrate
		this.environmentSnapshotManager = components.environmentSnapshotManager
		this.environmentSupervisorEngine = components.environmentSupervisorEngine
		this.environmentToolSuite = components.environmentToolSuite
		this.jitteredBackoffGovernor = components.jitteredBackoffGovernor
		this.deterministicErrorClassifier = components.deterministicErrorClassifier
		this.broccoliFaultSubstrate = components.broccoliFaultSubstrate
		this.faultSnapshotManager = components.faultSnapshotManager
		this.faultRecoverySupervisor = components.faultRecoverySupervisor
		this.faultDiagnosticToolSuite = components.faultDiagnosticToolSuite
		this.acpProtocolCodec = components.acpProtocolCodec
		this.acpPermissionGate = components.acpPermissionGate
		this.broccoliAcpSubstrate = components.broccoliAcpSubstrate
		this.acpSnapshotManager = components.acpSnapshotManager
		this.acpSpeculativeChangesetStager = components.acpSpeculativeChangesetStager
		this.acpFineGrainedHunkPatcher = components.acpFineGrainedHunkPatcher
		this.acpBridgeServer = components.acpBridgeServer
		this.acpToolSuite = components.acpToolSuite
		this.acpDashboardModal = components.acpDashboardModal
		this.mcpTransportCodec = components.mcpTransportCodec
		this.mcpSecurityScrubber = components.mcpSecurityScrubber
		this.broccoliMcpSubstrate = components.broccoliMcpSubstrate
		this.mcpSnapshotManager = components.mcpSnapshotManager
		this.mcpSupervisorEngine = components.mcpSupervisorEngine
		this.mcpClientToolSuite = components.mcpClientToolSuite
		this.processOutputRingBuffer = components.processOutputRingBuffer
		this.processSecuritySandbox = components.processSecuritySandbox
		this.broccoliProcessSubstrate = components.broccoliProcessSubstrate
		this.processSnapshotManager = components.processSnapshotManager
		this.processSupervisorEngine = components.processSupervisorEngine
		this.processToolSuite = components.processToolSuite
		this.securityRiskClassifier = components.securityRiskClassifier
		this.approvalHashLedger = components.approvalHashLedger
		this.broccoliArbiterSubstrate = components.broccoliArbiterSubstrate
		this.arbiterSnapshotManager = components.arbiterSnapshotManager
		this.interactiveSecurityArbiter = components.interactiveSecurityArbiter
		this.arbiterToolSuite = components.arbiterToolSuite
		this.semanticKnowledgeGraph = components.semanticKnowledgeGraph
		this.broccoliLearningSubstrate = components.broccoliLearningSubstrate
		this.learningSnapshotManager = components.learningSnapshotManager
		this.continuousLearningCurator = components.continuousLearningCurator
		this.learningCuratorToolSuite = components.learningCuratorToolSuite
		this.deterministicPatchEngine = components.deterministicPatchEngine
		this.broccoliPatchSubstrate = components.broccoliPatchSubstrate
		this.patchSnapshotManager = components.patchSnapshotManager
		this.atomicMutationSupervisor = components.atomicMutationSupervisor
		this.fileMutationToolSuite = components.fileMutationToolSuite
		this.deterministicLspEngine = components.deterministicLspEngine
		this.broccoliLspSubstrate = components.broccoliLspSubstrate
		this.lspSnapshotManager = components.lspSnapshotManager
		this.semanticCodeSupervisor = components.semanticCodeSupervisor
		this.lspCodeIntelligenceToolSuite = components.lspCodeIntelligenceToolSuite
		this.deterministicAudioCodec = components.deterministicAudioCodec
		this.broccoliVoiceSubstrate = components.broccoliVoiceSubstrate
		this.voiceSnapshotManager = components.voiceSnapshotManager
		this.voiceSpeechSupervisor = components.voiceSpeechSupervisor
		this.voiceSpeechToolSuite = components.voiceSpeechToolSuite
		this.deterministicImageCodec = components.deterministicImageCodec
		this.broccoliVisionSubstrate = components.broccoliVisionSubstrate
		this.visionSnapshotManager = components.visionSnapshotManager
		this.multimodalVisionSupervisor = components.multimodalVisionSupervisor
		this.multimodalVisionToolSuite = components.multimodalVisionToolSuite
		this.deterministicKanbanEngine = components.deterministicKanbanEngine
		this.broccoliKanbanSubstrate = components.broccoliKanbanSubstrate
		this.kanbanSnapshotManager = components.kanbanSnapshotManager
		this.kanbanBoardSupervisor = components.kanbanBoardSupervisor
		this.kanbanOrchestrationToolSuite = components.kanbanOrchestrationToolSuite
		this.deterministicWebEngine = components.deterministicWebEngine
		this.broccoliWebSubstrate = components.broccoliWebSubstrate
		this.webSnapshotManager = components.webSnapshotManager
		this.webIntelligenceSupervisor = components.webIntelligenceSupervisor
		this.webIntelligenceToolSuite = components.webIntelligenceToolSuite
		this.deterministicCodeExecutor = components.deterministicCodeExecutor
		this.broccoliExecutionSubstrate = components.broccoliExecutionSubstrate
		this.executionSnapshotManager = components.executionSnapshotManager
		this.codeExecutionSupervisor = components.codeExecutionSupervisor
		this.codeExecutionToolSuite = components.codeExecutionToolSuite
		this.deterministicBatchEvaluator = components.deterministicBatchEvaluator
		this.broccoliBatchSubstrate = components.broccoliBatchSubstrate
		this.batchSnapshotManager = components.batchSnapshotManager
		this.batchEvaluationSupervisor = components.batchEvaluationSupervisor
		this.batchEvaluationToolSuite = components.batchEvaluationToolSuite
		this.deterministicClarifyEngine = components.deterministicClarifyEngine
		this.broccoliClarifySubstrate = components.broccoliClarifySubstrate
		this.clarifySnapshotManager = components.clarifySnapshotManager
		this.clarifyInquirySupervisor = components.clarifyInquirySupervisor
		this.clarifyInquiryToolSuite = components.clarifyInquiryToolSuite
		this.deterministicThreatScanner = components.deterministicThreatScanner
		this.broccoliThreatSubstrate = components.broccoliThreatSubstrate
		this.threatSnapshotManager = components.threatSnapshotManager
		this.threatFirewallSupervisor = components.threatFirewallSupervisor
		this.threatFirewallToolSuite = components.threatFirewallToolSuite
		this.deterministicCasStore = components.deterministicCasStore
		this.broccoliCheckpointSubstrate = components.broccoliCheckpointSubstrate
		this.checkpointSnapshotManager = components.checkpointSnapshotManager
		this.checkpointKernelSupervisor = components.checkpointKernelSupervisor
		this.checkpointKernelToolSuite = components.checkpointKernelToolSuite
		this.deterministicDisplayDriver = components.deterministicDisplayDriver
		this.broccoliDisplaySubstrate = components.broccoliDisplaySubstrate
		this.displaySnapshotManager = components.displaySnapshotManager
		this.computerUseSupervisor = components.computerUseSupervisor
		this.computerUseToolSuite = components.computerUseToolSuite
		this.deterministicSkillsHub = components.deterministicSkillsHub
		this.broccoliSkillsHubSubstrate = components.broccoliSkillsHubSubstrate
		this.skillsHubSnapshotManager = components.skillsHubSnapshotManager
		this.skillsHubSupervisor = components.skillsHubSupervisor
		this.skillsHubToolSuite = components.skillsHubToolSuite
		this.deterministicCostGovernor = components.deterministicCostGovernor
		this.broccoliCostSubstrate = components.broccoliCostSubstrate
		this.costSnapshotManager = components.costSnapshotManager
		this.costGovernanceSupervisor = components.costGovernanceSupervisor
		this.costGovernanceToolSuite = components.costGovernanceToolSuite
		this.deterministicToolDiscloser = components.deterministicToolDiscloser
		this.broccoliDisclosureSubstrate = components.broccoliDisclosureSubstrate
		this.toolDisclosureSnapshotManager = components.toolDisclosureSnapshotManager
		this.toolDisclosureSupervisor = components.toolDisclosureSupervisor
		this.toolDisclosureToolSuite = components.toolDisclosureToolSuite
		this.deterministicEvidenceLedger = components.deterministicEvidenceLedger
		this.broccoliEvidenceSubstrate = components.broccoliEvidenceSubstrate
		this.evidenceSnapshotManager = components.evidenceSnapshotManager
		this.verificationEvidenceSupervisor = components.verificationEvidenceSupervisor
		this.verificationEvidenceToolSuite = components.verificationEvidenceToolSuite
		this.deterministicPromptCacher = components.deterministicPromptCacher
		this.broccoliPromptCacheSubstrate = components.broccoliPromptCacheSubstrate
		this.promptCacheSnapshotManager = components.promptCacheSnapshotManager
		this.promptCacheSupervisor = components.promptCacheSupervisor
		this.promptCacheToolSuite = components.promptCacheToolSuite
		this.deterministicToolSegmenter = components.deterministicToolSegmenter
		this.broccoliExecutionGuardSubstrate = components.broccoliExecutionGuardSubstrate
		this.executionGuardSnapshotManager = components.executionGuardSnapshotManager
		this.toolExecutionGuardSupervisor = components.toolExecutionGuardSupervisor
		this.toolExecutionGuardToolSuite = components.toolExecutionGuardToolSuite
		this.deterministicSecretRedactor = components.deterministicSecretRedactor
		this.broccoliRedactionSubstrate = components.broccoliRedactionSubstrate
		this.redactionSnapshotManager = components.redactionSnapshotManager
		this.secretRedactionSupervisor = components.secretRedactionSupervisor
		this.secretRedactionToolSuite = components.secretRedactionToolSuite
		this.deterministicReviewEvaluator = components.deterministicReviewEvaluator
		this.broccoliReviewSubstrate = components.broccoliReviewSubstrate
		this.reviewSnapshotManager = components.reviewSnapshotManager
		this.backgroundReviewSupervisor = components.backgroundReviewSupervisor
		this.backgroundReviewToolSuite = components.backgroundReviewToolSuite
		this.deterministicDiagnosticDoctor = components.deterministicDiagnosticDoctor
		this.broccoliDoctorSubstrate = components.broccoliDoctorSubstrate
		this.doctorSnapshotManager = components.doctorSnapshotManager
		this.diagnosticDoctorSupervisor = components.diagnosticDoctorSupervisor
		this.diagnosticDoctorToolSuite = components.diagnosticDoctorToolSuite
		this.deterministicAuthFederator = components.deterministicAuthFederator
		this.broccoliAuthSubstrate = components.broccoliAuthSubstrate
		this.authSnapshotManager = components.authSnapshotManager
		this.identityFederationSupervisor = components.identityFederationSupervisor
		this.identityFederationToolSuite = components.identityFederationToolSuite
		this.deterministicSessionArchiver = components.deterministicSessionArchiver
		this.broccoliArchiveSubstrate = components.broccoliArchiveSubstrate
		this.archiveSnapshotManager = components.archiveSnapshotManager
		this.sessionArchiveSupervisor = components.sessionArchiveSupervisor
		this.sessionArchiveToolSuite = components.sessionArchiveToolSuite
		this.deterministicSkinEngine = components.deterministicSkinEngine
		this.broccoliSkinSubstrate = components.broccoliSkinSubstrate
		this.skinSnapshotManager = components.skinSnapshotManager
		this.terminalSkinSupervisor = components.terminalSkinSupervisor
		this.terminalSkinToolSuite = components.terminalSkinToolSuite
		this.deterministicAuxiliaryRouter = components.deterministicAuxiliaryRouter
		this.broccoliAuxiliarySubstrate = components.broccoliAuxiliarySubstrate
		this.auxiliarySnapshotManager = components.auxiliarySnapshotManager
		this.auxiliaryRouterSupervisor = components.auxiliaryRouterSupervisor
		this.auxiliaryRouterToolSuite = components.auxiliaryRouterToolSuite
		this.deterministicReasoningScrubber = components.deterministicReasoningScrubber
		this.broccoliReasoningSubstrate = components.broccoliReasoningSubstrate
		this.reasoningSnapshotManager = components.reasoningSnapshotManager
		this.reasoningSupervisor = components.reasoningSupervisor
		this.reasoningToolSuite = components.reasoningToolSuite
		this.deterministicFuzzyMatcher = components.deterministicFuzzyMatcher
		this.broccoliFuzzySubstrate = components.broccoliFuzzySubstrate
		this.fuzzySnapshotManager = components.fuzzySnapshotManager
		this.fuzzyMatcherSupervisor = components.fuzzyMatcherSupervisor
		this.fuzzyMatcherToolSuite = components.fuzzyMatcherToolSuite
		this.deterministicTitleGenerator = components.deterministicTitleGenerator
		this.conversationInsightsEngine = components.conversationInsightsEngine
		this.titleInsightsSupervisor = components.titleInsightsSupervisor
		this.broccoliTitleInsightsSubstrate = components.broccoliTitleInsightsSubstrate
		this.titleInsightsSnapshotManager = components.titleInsightsSnapshotManager
		this.titleInsightsToolSuite = components.titleInsightsToolSuite
		this.deterministicHeredocSanitizer = components.deterministicHeredocSanitizer
		this.terminalDiagnosticsEngine = components.terminalDiagnosticsEngine
		this.heredocTerminalSupervisor = components.heredocTerminalSupervisor
		this.broccoliHeredocTerminalSubstrate = components.broccoliHeredocTerminalSubstrate
		this.heredocTerminalSnapshotManager = components.heredocTerminalSnapshotManager
		this.heredocTerminalToolSuite = components.heredocTerminalToolSuite
		this.deterministicStealthBrowser = components.deterministicStealthBrowser
		this.stealthBrowserSupervisor = components.stealthBrowserSupervisor
		this.broccoliStealthBrowserSubstrate = components.broccoliStealthBrowserSubstrate
		this.stealthBrowserSnapshotManager = components.stealthBrowserSnapshotManager
		this.stealthBrowserToolSuite = components.stealthBrowserToolSuite
		this.deterministicSkillsSyncClient = components.deterministicSkillsSyncClient
		this.skillsSyncSupervisor = components.skillsSyncSupervisor
		this.broccoliSkillsSyncSubstrate = components.broccoliSkillsSyncSubstrate
		this.skillsSyncSnapshotManager = components.skillsSyncSnapshotManager
		this.skillsSyncToolSuite = components.skillsSyncToolSuite
		this.deterministicPreflightScanner = components.deterministicPreflightScanner
		this.preflightScannerSupervisor = components.preflightScannerSupervisor
		this.broccoliPreflightSubstrate = components.broccoliPreflightSubstrate
		this.preflightSnapshotManager = components.preflightSnapshotManager
		this.preflightToolSuite = components.preflightToolSuite
		this.deterministicAudioSniffer = components.deterministicAudioSniffer
		this.audioContainerSupervisor = components.audioContainerSupervisor
		this.broccoliAudioContainerSubstrate = components.broccoliAudioContainerSubstrate
		this.audioContainerSnapshotManager = components.audioContainerSnapshotManager
		this.audioContainerToolSuite = components.audioContainerToolSuite
		this.deterministicSpeechTextNormalizer = components.deterministicSpeechTextNormalizer
		this.speechNormalizerSupervisor = components.speechNormalizerSupervisor
		this.broccoliSpeechNormalizerSubstrate = components.broccoliSpeechNormalizerSubstrate
		this.speechNormalizerSnapshotManager = components.speechNormalizerSnapshotManager
		this.speechNormalizerToolSuite = components.speechNormalizerToolSuite
		this.deterministicDocExtractor = components.deterministicDocExtractor
		this.docExtractorSupervisor = components.docExtractorSupervisor
		this.broccoliDocExtractorSubstrate = components.broccoliDocExtractorSubstrate
		this.docExtractorSnapshotManager = components.docExtractorSnapshotManager
		this.docExtractorToolSuite = components.docExtractorToolSuite
		this.deterministicSpillVault = components.deterministicSpillVault
		this.spillVaultSupervisor = components.spillVaultSupervisor
		this.broccoliSpillVaultSubstrate = components.broccoliSpillVaultSubstrate
		this.spillVaultSnapshotManager = components.spillVaultSnapshotManager
		this.spillVaultToolSuite = components.spillVaultToolSuite
		this.deterministicUrlSafety = components.deterministicUrlSafety
		this.urlSafetySupervisor = components.urlSafetySupervisor
		this.broccoliUrlSafetySubstrate = components.broccoliUrlSafetySubstrate
		this.urlSafetySnapshotManager = components.urlSafetySnapshotManager
		this.urlSafetyToolSuite = components.urlSafetyToolSuite
		this.deterministicV4aPatch = components.deterministicV4aPatch
		this.v4aPatchSupervisor = components.v4aPatchSupervisor
		this.broccoliV4aPatchSubstrate = components.broccoliV4aPatchSubstrate
		this.v4aPatchSnapshotManager = components.v4aPatchSnapshotManager
		this.v4aPatchToolSuite = components.v4aPatchToolSuite
		this.deterministicWebsitePolicy = components.deterministicWebsitePolicy
		this.websitePolicySupervisor = components.websitePolicySupervisor
		this.broccoliWebsitePolicySubstrate = components.broccoliWebsitePolicySubstrate
		this.websitePolicySnapshotManager = components.websitePolicySnapshotManager
		this.websitePolicyToolSuite = components.websitePolicyToolSuite
		this.deterministicWakeWord = components.deterministicWakeWord
		this.wakeWordSupervisor = components.wakeWordSupervisor
		this.broccoliWakeWordSubstrate = components.broccoliWakeWordSubstrate
		this.wakeWordSnapshotManager = components.wakeWordSnapshotManager
		this.wakeWordToolSuite = components.wakeWordToolSuite
		this.deterministicMediaResolver = components.deterministicMediaResolver
		this.mediaSourceSupervisor = components.mediaSourceSupervisor
		this.broccoliMediaSourceSubstrate = components.broccoliMediaSourceSubstrate
		this.mediaSourceSnapshotManager = components.mediaSourceSnapshotManager
		this.mediaSourceToolSuite = components.mediaSourceToolSuite
		this.deterministicGitWorktree = components.deterministicGitWorktree
		this.worktreeSupervisor = components.worktreeSupervisor
		this.broccoliWorktreeSubstrate = components.broccoliWorktreeSubstrate
		this.worktreeSnapshotManager = components.worktreeSnapshotManager
		this.worktreeToolSuite = components.worktreeToolSuite
		this.deterministicSpeechTranscriber = components.deterministicSpeechTranscriber
		this.transcriptionSupervisor = components.transcriptionSupervisor
		this.broccoliTranscriptionSubstrate = components.broccoliTranscriptionSubstrate
		this.transcriptionSnapshotManager = components.transcriptionSnapshotManager
		this.transcriptionToolSuite = components.transcriptionToolSuite
		this.deterministicDeadlineEngine = components.deterministicDeadlineEngine
		this.deadlineSupervisor = components.deadlineSupervisor
		this.broccoliDeadlineSubstrate = components.broccoliDeadlineSubstrate
		this.deadlineSnapshotManager = components.deadlineSnapshotManager
		this.deadlineToolSuite = components.deadlineToolSuite
		this.deterministicFileSafetyGuard = components.deterministicFileSafetyGuard
		this.fileSafetySupervisor = components.fileSafetySupervisor
		this.broccoliFileSafetySubstrate = components.broccoliFileSafetySubstrate
		this.fileSafetySnapshotManager = components.fileSafetySnapshotManager
		this.fileSafetyToolSuite = components.fileSafetyToolSuite
		this.deterministicContextBreakdownEngine = components.deterministicContextBreakdownEngine
		this.contextBreakdownSupervisor = components.contextBreakdownSupervisor
		this.broccoliContextBreakdownSubstrate = components.broccoliContextBreakdownSubstrate
		this.contextBreakdownSnapshotManager = components.contextBreakdownSnapshotManager
		this.contextBreakdownToolSuite = components.contextBreakdownToolSuite
		this.deterministicOsvParser = components.deterministicOsvParser
		this.osvScannerSupervisor = components.osvScannerSupervisor
		this.broccoliOsvSubstrate = components.broccoliOsvSubstrate
		this.osvScannerSnapshotManager = components.osvScannerSnapshotManager
		this.osvScannerToolSuite = components.osvScannerToolSuite
		this.deterministicSubdirHintEngine = components.deterministicSubdirHintEngine
		this.subdirHintsSupervisor = components.subdirHintsSupervisor
		this.broccoliSubdirHintsSubstrate = components.broccoliSubdirHintsSubstrate
		this.subdirHintsSnapshotManager = components.subdirHintsSnapshotManager
		this.subdirHintsToolSuite = components.subdirHintsToolSuite
		this.deterministicStreamDiagEngine = components.deterministicStreamDiagEngine
		this.streamDiagSupervisor = components.streamDiagSupervisor
		this.broccoliStreamDiagSubstrate = components.broccoliStreamDiagSubstrate
		this.streamDiagSnapshotManager = components.streamDiagSnapshotManager
		this.streamDiagToolSuite = components.streamDiagToolSuite
		this.deterministicTurnRetryEngine = components.deterministicTurnRetryEngine
		this.turnRetrySupervisor = components.turnRetrySupervisor
		this.broccoliTurnRetrySubstrate = components.broccoliTurnRetrySubstrate
		this.turnRetrySnapshotManager = components.turnRetrySnapshotManager
		this.turnRetryToolSuite = components.turnRetryToolSuite
		this.deterministicBillingUsageEngine = components.deterministicBillingUsageEngine
		this.billingUsageSupervisor = components.billingUsageSupervisor
		this.broccoliBillingUsageSubstrate = components.broccoliBillingUsageSubstrate
		this.billingUsageSnapshotManager = components.billingUsageSnapshotManager
		this.billingUsageToolSuite = components.billingUsageToolSuite
		this.deterministicThreadContextEngine = components.deterministicThreadContextEngine
		this.threadContextSupervisor = components.threadContextSupervisor
		this.broccoliThreadContextSubstrate = components.broccoliThreadContextSubstrate
		this.threadContextSnapshotManager = components.threadContextSnapshotManager
		this.threadContextToolSuite = components.threadContextToolSuite
		this.deterministicEnvProbeEngine = components.deterministicEnvProbeEngine
		this.envProbeSupervisor = components.envProbeSupervisor
		this.broccoliEnvProbeSubstrate = components.broccoliEnvProbeSubstrate
		this.envProbeSnapshotManager = components.envProbeSnapshotManager
		this.envProbeToolSuite = components.envProbeToolSuite
		this.deterministicSkillLinterEngine = components.deterministicSkillLinterEngine
		this.skillLinterSupervisor = components.skillLinterSupervisor
		this.broccoliSkillLinterSubstrate = components.broccoliSkillLinterSubstrate
		this.skillLinterSnapshotManager = components.skillLinterSnapshotManager
		this.skillLinterToolSuite = components.skillLinterToolSuite
		this.deterministicTerminalCleanerEngine = components.deterministicTerminalCleanerEngine
		this.terminalCleanerSupervisor = components.terminalCleanerSupervisor
		this.broccoliTerminalCleanerSubstrate = components.broccoliTerminalCleanerSubstrate
		this.terminalCleanerSnapshotManager = components.terminalCleanerSnapshotManager
		this.terminalCleanerToolSuite = components.terminalCleanerToolSuite
		this.deterministicStreamingScrubberEngine = components.deterministicStreamingScrubberEngine
		this.streamingScrubberSupervisor = components.streamingScrubberSupervisor
		this.broccoliStreamingScrubberSubstrate = components.broccoliStreamingScrubberSubstrate
		this.streamingScrubberSnapshotManager = components.streamingScrubberSnapshotManager
		this.streamingScrubberToolSuite = components.streamingScrubberToolSuite
		this.deterministicSelfRepoGuardEngine = components.deterministicSelfRepoGuardEngine
		this.selfRepoGuardSupervisor = components.selfRepoGuardSupervisor
		this.broccoliSelfRepoGuardSubstrate = components.broccoliSelfRepoGuardSubstrate
		this.selfRepoGuardSnapshotManager = components.selfRepoGuardSnapshotManager
		this.selfRepoGuardToolSuite = components.selfRepoGuardToolSuite
		this.deterministicSchemaSanitizerEngine = components.deterministicSchemaSanitizerEngine
		this.schemaSanitizerSupervisor = components.schemaSanitizerSupervisor
		this.broccoliSchemaSanitizerSubstrate = components.broccoliSchemaSanitizerSubstrate
		this.schemaSanitizerSnapshotManager = components.schemaSanitizerSnapshotManager
		this.schemaSanitizerToolSuite = components.schemaSanitizerToolSuite
		this.deterministicNousPortalEngine = components.deterministicNousPortalEngine
		this.nousPortalSupervisor = components.nousPortalSupervisor
		this.broccoliNousPortalSubstrate = components.broccoliNousPortalSubstrate
		this.nousPortalSnapshotManager = components.nousPortalSnapshotManager
		this.nousPortalToolSuite = components.nousPortalToolSuite
		this.deterministicGoalEngine = components.deterministicGoalEngine
		this.goalSupervisor = components.goalSupervisor
		this.broccoliGoalSubstrate = components.broccoliGoalSubstrate
		this.goalSnapshotManager = components.goalSnapshotManager
		this.goalToolSuite = components.goalToolSuite
		this.deterministicProfileEngine = components.deterministicProfileEngine
		this.profileSupervisor = components.profileSupervisor
		this.broccoliProfileSubstrate = components.broccoliProfileSubstrate
		this.profileSnapshotManager = components.profileSnapshotManager
		this.profileToolSuite = components.profileToolSuite
		this.databaseKernel = components.databaseKernel
		this.broccoliConnectionPool = components.broccoliConnectionPool
		this.broccoliLockAuthority = components.broccoliLockAuthority
		this.broccoliQueryOptimizer = components.broccoliQueryOptimizer
		this.broccoliMvccEngine = components.broccoliMvccEngine
		this.broccoliSparseIndexEngine = components.broccoliSparseIndexEngine
		this.broccoliCdcStream = components.broccoliCdcStream
		this.broccoliVectorEngine = components.broccoliVectorEngine
		this.broccoliInvertedIndexEngine = components.broccoliInvertedIndexEngine
		this.broccoliTwoPhaseCommitCoordinator = components.broccoliTwoPhaseCommitCoordinator
		this.broccoliBufferPoolManager = components.broccoliBufferPoolManager
		this.broccoliLsmStore = components.broccoliLsmStore
		this.broccoliRaftConsensusEngine = components.broccoliRaftConsensusEngine
		this.broccoliAdaptivePlanCache = components.broccoliAdaptivePlanCache
		this.broccoliSagaOrchestrator = components.broccoliSagaOrchestrator
		this.broccoliTieredKvCache = components.broccoliTieredKvCache
		this.broccoliVectorAnnEngine = components.broccoliVectorAnnEngine
		this.broccoliConsistentHashRing = components.broccoliConsistentHashRing
		this.broccoliTimeSeriesRollupEngine = components.broccoliTimeSeriesRollupEngine
		this.broccoliBTreeIndexEngine = components.broccoliBTreeIndexEngine
		this.broccoliDeadlockDetector = components.broccoliDeadlockDetector
		this.broccoliMaterializedViewEngine = components.broccoliMaterializedViewEngine
		this.databaseToolSuite = components.databaseToolSuite
		this.deterministicWalletEngine = components.deterministicWalletEngine
		this.walletSupervisor = components.walletSupervisor
		this.broccoliWalletSubstrate = components.broccoliWalletSubstrate
		this.walletSnapshotManager = components.walletSnapshotManager
		this.walletToolSuite = components.walletToolSuite
		this.deterministicEmailEngine = components.deterministicEmailEngine
		this.emailSupervisor = components.emailSupervisor
		this.broccoliEmailSubstrate = components.broccoliEmailSubstrate
		this.emailSnapshotManager = components.emailSnapshotManager
		this.emailToolSuite = components.emailToolSuite
		this.deterministicOtlpEngine = components.deterministicOtlpEngine
		this.otlpSupervisor = components.otlpSupervisor
		this.broccoliOtlpSubstrate = components.broccoliOtlpSubstrate
		this.otlpSnapshotManager = components.otlpSnapshotManager
		this.otlpToolSuite = components.otlpToolSuite
		this.deterministicAcpEngine = components.deterministicAcpEngine
		this.acpSupervisor = components.acpSupervisor
		this.deterministicDaemonEngine = components.deterministicDaemonEngine
		this.daemonSupervisor = components.daemonSupervisor
		this.broccoliDaemonSubstrate = components.broccoliDaemonSubstrate
		this.daemonSnapshotManager = components.daemonSnapshotManager
		this.daemonToolSuite = components.daemonToolSuite
		this.broccoliRunbookSubstrate = components.broccoliRunbookSubstrate
		this.runbookSupervisor = components.runbookSupervisor
		this.runbookToolSuite = components.runbookToolSuite
		this.broccoliAdversarialSubstrate = components.broccoliAdversarialSubstrate
		this.adversarialScrutinySupervisor = components.adversarialScrutinySupervisor
		this.adversarialHumanizer = components.adversarialHumanizer
		this.adversarialToolSuite = components.adversarialToolSuite
		this.toolRegistry = components.toolRegistry
		this.promptComposer = components.promptComposer
		this.agentEngine = components.agentEngine
	}

	/** Primary Game Engine Frame Step (Tick Loop) */
	async tick(input: EngineTickInput): Promise<EngineTickResult> {
		return this.telemetryTracer.startSpan(`tick-frame-${this.sessionContext.turnCount + 1}`, async (span) => {
			this.telemetryTracer.addEvent(span, "frame_start", { promptLength: input.prompt.length })
			this.loopPhaseController.setPhase("thinking")
			const startTime = Date.now()
			try {
				const res = await this.agentEngine.tick(input)
				this.timingBuffer.record("frame_tick", Date.now() - startTime)
				span.attributes["turn.outcome"] = res.outcome
				if (res.outcome !== "completed") span.status = "error"
				this.telemetryTracer.addEvent(span, "frame_terminal", {
					outcome: res.outcome,
					responseLength: res.response.length,
				})
				return res
			} finally {
				this.loopPhaseController.setPhase("idle")
			}
		})
	}

	/** Backward-compatible turn runner */
	async runTurn(prompt: string): Promise<EngineTickResult> {
		return this.tick({ prompt })
	}

	/** Dynamically changes the active LLM model with alias normalization */
	setModel(modelName: string): string {
		const normalized = this.modelResolver.setActiveModel(modelName)
		;(this.config as { modelName: string }).modelName = normalized
		this.setupWizard.setSavedModel(normalized)
		return normalized
	}

	/** Selects the active transport and keeps the model on that provider's catalog. */
	setProvider(provider: AgentProviderId): AgentProviderId {
		const normalizedProvider = normalizeAgentProvider(provider)
		this.modelResolver.setProvider(normalizedProvider)
		;(this.config as { provider: AgentProviderId }).provider = normalizedProvider
		this.setModel(this.modelResolver.getActiveModel())
		const persistableProvider =
			normalizedProvider === OPENAI_CODEX_PROVIDER
				? OPENAI_CODEX_PROVIDER
				: normalizedProvider === CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER
					? CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER
					: undefined
		if (persistableProvider) {
			this.setupWizard.setSavedProvider(persistableProvider)
		}
		return normalizedProvider
	}

	/** Switches to the active provider's primary model without crossing provider boundaries. */
	switchToTerra(): string {
		return this.setModel(this.modelResolver.switchToTerra())
	}

	/** Backwards-compatible quick switch; resolves against the active provider. */
	switchToLuna(): string {
		return this.setModel(this.modelResolver.switchToLuna())
	}

	/** Backwards-compatible quick switch; resolves against the active provider. */
	switchToSol(): string {
		return this.setModel(this.modelResolver.switchToSol())
	}

	/** Cycles through the active provider's known model routes. */
	cycleModel(): string {
		const next = this.modelResolver.cycleCodexModel()
		;(this.config as { modelName: string }).modelName = next
		this.setupWizard.setSavedModel(next)
		return next
	}

	/** Backwards-compatible alias for cycleModel */
	cycleCodexModel(): string {
		return this.cycleModel()
	}

	/** Adversarially red-teams an architectural or implementation plan */
	scrutinizePlan(planText: string, options?: AdversarialScrutinyOptions): AdversarialRedTeamVerdict {
		return this.adversarialScrutinySupervisor.scrutinizePlan(planText, options)
	}

	/** Audits factual claims against evidence source to ensure fail-closed grounding */
	auditProvenance(claim: string, evidenceSource: string, options?: AdversarialScrutinyOptions): ProvenanceGroundingProof {
		return this.adversarialScrutinySupervisor.auditProvenance(claim, evidenceSource, options)
	}

	/** Decomposes cognitive token spend into compressible fluff vs irreducible core constraints */
	decomposeCognitiveSpend(text: string): CognitiveDecompositionReport {
		return this.adversarialScrutinySupervisor.decomposeCognitiveSpend(text)
	}

	/** Audits completion assertions against empirical execution receipts */
	verifyTaskCompletion(declaredSummary: string, evidenceReceipts: readonly string[]): AdversarialRedTeamVerdict {
		return this.adversarialScrutinySupervisor.verifyTaskCompletion(declaredSummary, evidenceReceipts)
	}

	/** Creates an immutable frame-perfect snapshot of active game engine state */
	createSnapshot(): GameStateSnapshot {
		const snapshot = this.sessionStore.createSnapshot(
			this.sessionContext.turnCount,
			this.sessionVfs,
			this.sessionMemoryStore,
			this.modelResolver,
		)
		this.snapshotLruCache.set(snapshot.snapshotId, snapshot)
		this.snapshotStorageIndex.saveSnapshot(snapshot)
		return snapshot
	}

	/** Frame-perfect state rewind to a target snapshot */
	rewindToSnapshot(snapshot: GameStateSnapshot): void {
		this.sessionStore.rewindToSnapshot(snapshot)
		this.sessionContext.turnCount = snapshot.frameIndex
		if (snapshot.memories) {
			this.sessionMemoryStore.clear()
			for (const m of snapshot.memories) {
				const cat = m.category === "rule" || m.category === "troubleshooting" || m.category === "ki" ? m.category : "fact"
				this.sessionMemoryStore.saveMemory(m.key, m.value, cat)
			}
		}
		if (snapshot.stagedFiles) {
			this.sessionVfs.clear()
			for (const file of snapshot.stagedFiles) {
				if (file.isDeleted) this.sessionVfs.stageDelete(file.path, file.diskBaseline)
				else this.sessionVfs.stageWrite(file.path, file.stagedContent, file.diskBaseline)
			}
		}
	}

	/** Forks game engine state into a new isolated engine instance */
	forkSession(newSessionId?: string): LumiMonolith {
		const snapshot = this.createSnapshot()
		const forkedMonolith = new LumiMonolith({
			cwd: this.sessionContext.cwd,
			sessionId: newSessionId ?? `${this.sessionContext.sessionId}-fork-${Date.now()}`,
			config: this.config,
		})
		forkedMonolith.rewindToSnapshot(snapshot)
		return forkedMonolith
	}
}

// CLI entrypoint when run directly, including through an npm-link symlink.
const cliEntrypoint = process.argv[1]
let isDirectCliExecution = false
if (cliEntrypoint) {
	try {
		isDirectCliExecution = realpathSync(cliEntrypoint) === realpathSync(fileURLToPath(import.meta.url))
	} catch {
		isDirectCliExecution = pathToFileURL(cliEntrypoint).href === import.meta.url
	}
}

if (isDirectCliExecution) {
	const args = process.argv.slice(2)
	const primaryCmd = args[0]?.toLowerCase()
	const providerFlagIndex = args.indexOf("--provider")
	const providerFlagValue = providerFlagIndex >= 0 ? args[providerFlagIndex + 1] : undefined
	const modelFlagIndex = args.indexOf("--model")
	const modelFlagValue = modelFlagIndex >= 0 ? args[modelFlagIndex + 1] : undefined
	const positionalArgs = args.filter(
		(_arg, index) =>
			index !== providerFlagIndex &&
			index !== providerFlagIndex + 1 &&
			index !== modelFlagIndex &&
			index !== modelFlagIndex + 1,
	)
	const configuredProviderValue = providerFlagValue || process.env.LUMI_PROVIDER
	const configuredProvider = normalizeAgentProvider(configuredProviderValue)
	const configuredModelValue = modelFlagValue || process.env.LUMI_MODEL_ID
	const supportedCliProviders = new Set<AgentProviderId>([OPENAI_CODEX_PROVIDER, CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER])

	const isSmoke = args.includes("--smoke") || args.includes("-s") || primaryCmd === "smoke"
	const isSetup = args.includes("--setup") || primaryCmd === "setup"
	const isBenchmark = args.includes("--benchmark") || args.includes("-b") || primaryCmd === "benchmark"
	const isBaseline = args.includes("--baseline") || primaryCmd === "baseline"
	const isHelp = args.includes("--help") || args.includes("-h") || primaryCmd === "help"

	const isLogin = args.includes("--login") || primaryCmd === "login" || (primaryCmd === "auth" && args[1] === "login")
	const isLogout = args.includes("--logout") || primaryCmd === "logout" || (primaryCmd === "auth" && args[1] === "logout")
	const isWhoAmI =
		args.includes("--whoami") ||
		primaryCmd === "whoami" ||
		(primaryCmd === "auth" && (!args[1] || args[1] === "status" || args[1] === "whoami"))
	const isDoctor = args.includes("--doctor") || args.includes("--health") || primaryCmd === "doctor" || primaryCmd === "health"
	const isModels = args.includes("--models") || primaryCmd === "models"
	const isLocal = args.includes("--local") || primaryCmd === "local" || primaryCmd === "onprem"
	const isPull = primaryCmd === "pull"
	const isHardware =
		args.includes("--hardware") || args.includes("--vram") || primaryCmd === "hardware" || primaryCmd === "vram"

	const isTerra = primaryCmd === "terra"
	const isLuna = primaryCmd === "luna"
	const isSol = primaryCmd === "sol"
	const isModelSwitch = primaryCmd === "model" && Boolean(args[1])

	if (isHelp) {
		const modelExample = isClaudeSubscriptionDirectSdkProvider(configuredProvider) ? "claude-sonnet-5[1m]" : "terra"
		const modelCommands = isClaudeSubscriptionDirectSdkProvider(configuredProvider)
			? `  heav3ns models [--refresh]  Resolve the signed-in Claude Code account route catalog
  heav3ns model <route>       Set an account route (e.g. ${modelExample})`
			: `  heav3ns terra               Quick-switch default model to Flagship Reasoning Engine (gpt-5.6-terra)
  heav3ns luna                Quick-switch default model to High-Velocity Engine (gpt-5.6-luna)
  heav3ns sol                 Quick-switch default model to Balanced Engine (gpt-5.6-sol)
  heav3ns model <name>        Set active model by name or alias (e.g. heav3ns model luna)
  heav3ns models [--refresh]  Display the curated catalog (and refresh OpenAI Codex models)`
		console.log(`
\x1b[1;35m❖ HEAV3NS Agent OS — Command Line Interface\x1b[0m

\x1b[1;34mInteractive Mode:\x1b[0m
  heav3ns                     Start interactive terminal TUI session
  heav3ns --provider <id>    Select provider (codex/openai or claude-code)
  heav3ns --model <name>      Start with an active route (e.g. ${modelExample})

\x1b[1;34mModel Swapping & Catalog:\x1b[0m
${modelCommands}
\x1b[1;34mAuthentication & Identity:\x1b[0m
  heav3ns login               Sign in with ChatGPT / OpenAI (1-Click browser login)
  heav3ns logout              Sign out and clear local session
  heav3ns whoami              Display active account, subscription tier, and model
  heav3ns doctor              Run system health and connectivity check
  heav3ns setup               Interactive account and model settings

\x1b[1;34mLocal On-Premises & Models:\x1b[0m
  heav3ns local               Auto-sense and probe local LLM servers (Ollama, LM Studio, llama.cpp)
  heav3ns local --hardware    Display host RAM, GPU / Apple Silicon VRAM compatibility report
  heav3ns local --benchmark   Run Tokens-Per-Second (TPS) speed benchmark on local models
  heav3ns local --unload [model] Purge model from GPU memory to reclaim VRAM
  heav3ns local --ps          List models currently loaded in GPU VRAM
  heav3ns pull <model>        Stream and download an open-weight Ollama model (e.g. heav3ns pull llama3.2)

\x1b[1;34mSystem & Configuration:\x1b[0m
  heav3ns doctor              Run system health, permissions, hardware, and connectivity diagnostic audit
  heav3ns setup               Launch step-by-step interactive configuration wizard

\x1b[1;34mWorkload & Benchmarks:\x1b[0m
  heav3ns "your prompt"       Execute a single non-interactive prompt turn
  heav3ns benchmark (-b)      Run automated engine throughput and latency benchmark suite
  heav3ns baseline            Run smoke + benchmark + guardrails to update live baseline
  heav3ns smoke (-s)          Run runtime capability smoke verification suite
  heav3ns help (-h)           Show this help message
`)
		process.exit(0)
	}

	const runSmokeTest = async (lumi: LumiMonolith): Promise<RuntimeSmokeReport> => {
		console.log("\x1b[1;36m========================================================\x1b[0m")
		console.log("\x1b[1;36m   HEAV3NS Current Runtime Capability Smoke Suite       \x1b[0m")
		console.log("\x1b[1;36m========================================================\x1b[0m\n")

		const report = await new RuntimeSmokeSuite().run(lumi)
		console.log(`Evolution Baseline:       \x1b[36m${report.baseline.label}\x1b[0m`)
		console.log(`Composed Components:      \x1b[36m${report.composition.componentCount}\x1b[0m`)
		console.log(`Required Capabilities:    \x1b[36m${report.composition.requiredComponentCount}\x1b[0m\n`)

		for (const check of report.checks) {
			const status = check.passed ? "\x1b[32m[PASS]\x1b[0m" : "\x1b[31m[FAIL]\x1b[0m"
			console.log(`  ${status} ${check.name}`)
			console.log(`         ${check.detail} (${check.durationMs.toFixed(2)} ms)`)
		}

		console.log(
			`\nSmoke Result: ${report.passed ? "\x1b[1;32mPASSED" : "\x1b[1;31mFAILED"}\x1b[0m · ${report.passedCount}/${report.totalChecks} checks · ${report.durationMs.toFixed(2)} ms\n`,
		)
		return report
	}

	const runBenchmarkSuite = async (lumi: LumiMonolith): Promise<GrandBenchmarkResult> => {
		console.log("\x1b[1;36m========================================================\x1b[0m")
		console.log("\x1b[1;36m   HEAV3NS Monolith Benchmark & Throughput Test Suite   \x1b[0m")
		console.log("\x1b[1;36m========================================================\x1b[0m\n")

		const rewindSnapshot = lumi.createSnapshot()
		const rewindMutation = await lumi.tick({ prompt: "remember: benchmark_rewind = mutated" })
		if (rewindMutation.outcome !== "completed") {
			throw new Error("Unable to prepare deterministic rewind benchmark")
		}

		const benchmarkResult = await lumi.masterBenchmarkOrchestrator.runGrandBenchmarkSuite(lumi, [
			{
				name: "Turn Tick Latency & Fact Storage",
				prompt: "remember: engine = deterministic",
				expectedKeywords: ["deterministic"],
			},
			{ name: "VFS File Perception & Reading", prompt: "view: package.json", expectedKeywords: ["package.json"] },
			{
				name: "Complete Flappy Bird React + TypeScript + Vite Synthesis",
				expectedKeywords: ["Generated 12-file", "gameplay state-machine simulation"],
				execute: () => new FlappyBirdProjectBenchmark().execute(),
			},
			{ name: "Slash Command Router Latency", prompt: "/stats", expectedKeywords: ["Telemetry"] },
			{
				name: "Snapshot State Rewind Latency",
				expectedKeywords: ["rewound"],
				execute: (current) => {
					current.rewindToSnapshot(rewindSnapshot)
					const restored =
						current.sessionContext.turnCount === rewindSnapshot.frameIndex &&
						current.sessionStore.getMessages().length === rewindSnapshot.messages.length
					return {
						outcome: restored ? "completed" : "failed",
						response: restored ? `Rewound to frame ${rewindSnapshot.frameIndex}` : "Snapshot rewind state mismatch",
						assertionPassed: restored,
					}
				},
			},
		])

		console.log(`\x1b[1;32mBenchmark Results:\x1b[0m`)
		console.log(`  Total Evaluated Tests:  \x1b[36m${benchmarkResult.suiteResult.totalTests}\x1b[0m`)
		console.log(`  Passed Tests:           \x1b[32m${benchmarkResult.suiteResult.passCount}\x1b[0m`)
		console.log(`  Failed Tests:           \x1b[31m${benchmarkResult.suiteResult.failCount}\x1b[0m`)
		console.log(`  Pass Rate:              \x1b[33m${benchmarkResult.suiteResult.passRate}%\x1b[0m`)
		console.log(`  Mean Case Latency:      \x1b[36m${benchmarkResult.suiteResult.meanLatencyMs} ms\x1b[0m`)
		console.log(`  Total Test Time:        \x1b[36m${benchmarkResult.totalDurationMs} ms\x1b[0m`)
		console.log(
			`  Workload Throughput:    \x1b[1;32m${benchmarkResult.throughputTps} cases/sec (${benchmarkResult.throughputPerMinute} cases/min)\x1b[0m\n`,
		)

		console.log("\x1b[1;34mDetailed Test Case Metrics:\x1b[0m")
		for (const res of benchmarkResult.suiteResult.results) {
			const status = res.passed ? "\x1b[32m[PASS]\x1b[0m" : "\x1b[31m[FAIL]\x1b[0m"
			const assertionSummary =
				res.assertions.length > 0
					? ` · Assertions: ${res.assertions.filter((assertion) => assertion.passed).length}/${res.assertions.length}`
					: ""
			console.log(
				`  ${status} ${res.testName.padEnd(62)} -> Latency: \x1b[33m${res.durationMs} ms\x1b[0m${assertionSummary}`,
			)
			for (const assertion of res.assertions) {
				const assertionStatus = assertion.passed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"
				console.log(`         ${assertionStatus} ${assertion.name}: ${assertion.detail}`)
			}
		}
		console.log()
		return benchmarkResult
	}

	const updateLiveBaseline = async (lumi: LumiMonolith): Promise<boolean> => {
		const smoke = await runSmokeTest(lumi)
		const benchmark = await runBenchmarkSuite(lumi)
		const guardrails = await new ArchitectureGuardrailGate().runFullGuardrailAudit(lumi)
		const writeResult = new LiveBaselineReporter().write(process.cwd(), {
			repositoryVersion: process.env.npm_package_version ?? "0.1.0",
			configuredModel: lumi.modelResolver.getActiveModel(),
			smoke,
			benchmark,
			guardrails,
		})

		console.log("\x1b[1;34mLive baseline artifacts:\x1b[0m")
		for (const file of writeResult.files) console.log(`  - ${file}`)
		console.log(`  Generated: ${writeResult.generatedAt}`)
		console.log(`  Guardrails: ${guardrails.passedCount}/${guardrails.totalChecks}`)
		console.log(`  Status: ${writeResult.passed ? "\x1b[1;32mPASSED" : "\x1b[1;31mFAILED"}\x1b[0m\n`)
		return writeResult.passed
	}

	const startRepl = async (lumi: LumiMonolith) => {
		await lumi.interactiveController.startInteractiveSession(lumi)
	}

	let stateManagerInitialized = false
	let workspaceOwner: Awaited<ReturnType<typeof import("./desktop/workspace-owner.js").acquireWorkspace>> | undefined
	;(async () => {
		if (primaryCmd === "--desktop-worker") {
			await (await import("./desktop/worker.js")).runDesktopWorker()
			return
		}
		if (providerFlagIndex >= 0 && !providerFlagValue) throw new Error("--provider requires a provider ID")
		if (modelFlagIndex >= 0 && !modelFlagValue) throw new Error("--model requires a model route")
		if (configuredProviderValue && !supportedCliProviders.has(configuredProvider)) {
			throw new Error(
				`Unsupported active provider "${configuredProviderValue}". Supported providers: ${Array.from(supportedCliProviders).join(", ")}`,
			)
		}
		if (!HostProvider.isInitialized()) {
			HostProvider.initializeHeadless()
		}
		try {
			await StateManager.initialize(createStorageContext({ workspacePath: process.cwd() }))
			stateManagerInitialized = true
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error)
			throw new Error(
				`Could not initialize HEAV3NS CLI storage at "${getStorageDataDirectory()}". Check that the directory is writable or set DIETCODE_DIR to a writable location. ${detail}`,
			)
		}
		workspaceOwner = await (await import("./desktop/workspace-owner.js")).acquireWorkspace(process.cwd())
		const lumi = new LumiMonolith(configuredProviderValue ? { provider: configuredProvider } : {})
		if (configuredModelValue) {
			lumi.setModel(configuredModelValue)
		}

		if (isLogin) {
			await lumi.setupWizard.loginInteractive()
		} else if (isSetup) {
			await lumi.setupWizard.runInteractiveWizard()
		} else if (isLogout) {
			lumi.setupWizard.logout()
			console.log("\n\x1b[1;32m[✓] Successfully signed out of configured providers.\x1b[0m")
			console.log("\x1b[90mRun \x1b[36mheav3ns login\x1b[90m anytime to reconnect.\x1b[0m\n")
		} else if (isWhoAmI) {
			lumi.setupWizard.displayWhoAmI(lumi.modelResolver.getActiveModel())
		} else if (isDoctor) {
			await lumi.setupWizard.displayDoctor(lumi.config.provider)
		} else if (isPull) {
			const modelTag = args[1]?.trim() || "qwen2.5-coder:7b"
			console.log(`\n\x1b[1;36mConnecting to pull ${modelTag} via Ollama...\x1b[0m\n`)
			try {
				await lumi.proxyGateway.getLocalEngine().pullModel(modelTag, {
					onProgress: (p) => {
						process.stdout.write(`\r${p.progressBarText}   `)
					},
				})
				console.log(`\n\n\x1b[1;32m[✓] Model ${modelTag} downloaded and ready for offline inference!\x1b[0m\n`)
			} catch (err: any) {
				console.error(`\n\n\x1b[1;31m[✗] Failed to pull model:\x1b[0m ${err.message || String(err)}\n`)
			}
		} else if (isHardware) {
			console.log()
			console.log(lumi.proxyGateway.getLocalEngine().getHardwareCard())
		} else if (isLocal) {
			if (args.includes("--hardware") || args.includes("--vram")) {
				console.log()
				console.log(lumi.proxyGateway.getLocalEngine().getHardwareCard())
			} else if (args.includes("--benchmark") || args.includes("--speed")) {
				const bIdx = args.includes("--benchmark") ? args.indexOf("--benchmark") : args.indexOf("--speed")
				const targetM = args[bIdx + 1] && !args[bIdx + 1]?.startsWith("-") ? args[bIdx + 1]! : "qwen2.5-coder:7b"
				console.log(`\n\x1b[33m⚡ Benchmarking local inference speed on ${targetM}...\x1b[0m\n`)
				const res = await lumi.proxyGateway.getLocalEngine().benchmarkModel(targetM)
				console.log(res.speedScorecard)
			} else if (args.includes("--unload") || args.includes("--purge")) {
				const uIdx = args.includes("--unload") ? args.indexOf("--unload") : args.indexOf("--purge")
				const targetM = args[uIdx + 1]
				if (targetM && !targetM.startsWith("-")) {
					const res = await lumi.proxyGateway.getLocalEngine().unloadModel(targetM)
					console.log(`\n\x1b[32m[✓] ${res.message}\x1b[0m\n`)
				} else {
					const res = await lumi.proxyGateway.getLocalEngine().unloadAllModels()
					console.log(`\n\x1b[32m[✓] Purged ${res.length} model(s) from GPU VRAM memory.\x1b[0m\n`)
				}
			} else if (args.includes("--ps")) {
				const loaded = await lumi.proxyGateway.getLocalEngine().getLoadedModels()
				console.log(`\n\x1b[1;36mModels Resident in GPU VRAM (${loaded.length}):\x1b[0m`)
				if (loaded.length === 0) {
					console.log(`  \x1b[90mNo models currently active in VRAM.\x1b[0m`)
				} else {
					for (const m of loaded) {
						console.log(` • \x1b[33m${m.name}\x1b[0m (${m.sizeGb} GB VRAM) — Expires: ${m.expiresAt}`)
					}
				}
				console.log()
			} else if (args.includes("--start")) {
				console.log("\n\x1b[33mAttempting to spawn Ollama daemon in background...\x1b[0m")
				const res = await lumi.proxyGateway.getLocalEngine().startLocalServer("ollama")
				console.log(res.started ? `\x1b[32m[✓] ${res.message}\x1b[0m\n` : `\x1b[31m[✗] ${res.message}\x1b[0m\n`)
			} else {
				console.log("\n\x1b[1;35m╭─── HEAV3NS Local & On-Premises Engine Fleet Probe ────────────╮\x1b[0m")
				const report = await lumi.proxyGateway.getLocalEngine().probeAllServers()
				console.log(
					`│  Active Servers Online: \x1b[1;36m${report.activeServers}/${report.totalServersChecked}\x1b[0m · Total Discovered Models: \x1b[1;33m${report.totalLocalModelsDiscovered}\x1b[0m`,
				)
				console.log(`│`)
				for (const s of report.serverStatuses) {
					const badge = s.reachable
						? `\x1b[32m● ONLINE\x1b[0m (${s.latencyMs}ms, ${s.activeModelCount} models)`
						: `\x1b[90m○ OFFLINE\x1b[0m`
					console.log(
						`│  • \x1b[1;37m${s.displayName.padEnd(24)}\x1b[0m \x1b[36m${s.baseUrl.padEnd(24)}\x1b[0m ${badge}`,
					)
					if (s.detectedModels.length > 0) {
						for (const m of s.detectedModels.slice(0, 3)) {
							const vramBadge = m.vramCompatibility?.badge || ""
							console.log(`│      └─ \x1b[90mModel:\x1b[0m \x1b[33m${m.modelId}\x1b[0m ${vramBadge}`)
						}
					}
				}
				console.log("\x1b[1;35m╰───────────────────────────────────────────────────────────────╯\x1b[0m")
				console.log(
					`\x1b[90mStart local models with \x1b[36mollama run llama3.2\x1b[90m, pull with \x1b[36mheav3ns pull <model>\x1b[90m, or connect in TUI with \x1b[36m/local\x1b[90m.\x1b[0m\n`,
				)
			}
		} else if (isTerra) {
			const active = lumi.switchToTerra()
			console.log(
				`\n\x1b[1;32m[✓] Active LLM Model set to:\x1b[0m \x1b[1;36m${active}\x1b[0m (Flagship Reasoning Engine · 900k Context · 16k Max Output)\n`,
			)
		} else if (isLuna) {
			const active = lumi.switchToLuna()
			console.log(
				`\n\x1b[1;32m[✓] Active LLM Model set to:\x1b[0m \x1b[1;36m${active}\x1b[0m (High-Velocity Engine · 900k Context · 8k Max Output)\n`,
			)
		} else if (isSol) {
			const active = lumi.switchToSol()
			console.log(
				`\n\x1b[1;32m[✓] Active LLM Model set to:\x1b[0m \x1b[1;36m${active}\x1b[0m (Balanced Engine · 900k Context · 8k Max Output)\n`,
			)
		} else if (isModelSwitch) {
			const targetModel = args.slice(1).join(" ").trim()
			const active = lumi.setModel(targetModel)
			console.log(`\n\x1b[1;32m[✓] Active LLM Model set to:\x1b[0m \x1b[1;36m${active}\x1b[0m\n`)
		} else if (isModels) {
			const force = args.includes("--refresh") || args.includes("-r")
			const isClaudeProvider = isClaudeSubscriptionDirectSdkProvider(lumi.config.provider)
			let models: ReturnType<ModelCatalog["getAllModels"]>
			if (isClaudeProvider) {
				console.log("\n\x1b[33mResolving the signed-in Claude Code model picker…\x1b[0m")
				const catalog = await lumi.modelCatalog.refreshClaudeSubscriptionDirectSdkModels(
					{
						pluginDir: lumi.config.claudePluginDir,
						pythonPath: lumi.config.claudePythonPath,
						command: lumi.config.claudeCommand,
						cwd: lumi.sessionContext.cwd,
					},
					force,
				)
				models = catalog.models
				console.log(
					catalog.source === "live"
						? "\x1b[32m[✓] Live account-scoped Claude routes loaded.\x1b[0m"
						: "\x1b[33m[!] Live picker unavailable; showing verified upstream fallback routes.\x1b[0m",
				)
				if (catalog.source === "pinned" && catalog.detail) {
					console.log(`\x1b[90m  Diagnostic: ${catalog.detail.slice(0, 240)}\x1b[0m`)
				}
			} else {
				if (force) {
					console.log("\n\x1b[33mFetching latest models dynamically from OpenAI Codex...\x1b[0m")
					await lumi.modelCatalog.fetchCodexModels(undefined, true)
				}
				models = lumi.modelCatalog.getAllModels()
			}
			console.log("\n\x1b[1;35m╭─── HEAV3NS Curated & Dynamic Model Catalog ───────────────────╮\x1b[0m")
			const active = lumi.modelResolver.getActiveModel()
			for (const m of models) {
				const isCurrent = m.modelName === active ? " \x1b[32m[ACTIVE]\x1b[0m" : ""
				const contextLabel = m.contextWindowTokens >= 1_000_000 ? "1M" : `${Math.round(m.contextWindowTokens / 1000)}k`
				console.log(
					`│  • \x1b[1;36m${m.modelName.padEnd(24)}\x1b[0m \x1b[90m(${getAgentProviderLabel(m.provider).padEnd(14)})\x1b[0m \x1b[33m${contextLabel} ctx\x1b[0m${isCurrent}`,
				)
			}
			console.log("\x1b[1;35m╰───────────────────────────────────────────────────────────────╯\x1b[0m")
			console.log(
				isClaudeProvider
					? "\x1b[90mChoose an account route with \x1b[36mheav3ns --provider claude-code --model <route>\x1b[90m or use \x1b[36m/model <route>\x1b[90m.\x1b[0m\n"
					: "\x1b[90mSwitch models instantly with \x1b[36mheav3ns terra\x1b[90m, \x1b[36mheav3ns luna\x1b[90m, \x1b[36mheav3ns sol\x1b[90m, or in TUI with \x1b[36m/model <name>\x1b[90m.\x1b[0m\n",
			)
		} else if (isBaseline) {
			const passed = await updateLiveBaseline(lumi)
			if (!passed) throw new Error("Live baseline verification failed")
		} else if (isBenchmark) {
			const benchmark = await runBenchmarkSuite(lumi)
			if (!benchmark.passed) throw new Error("Benchmark suite failed")
		} else if (isSmoke) {
			const smoke = await runSmokeTest(lumi)
			if (!smoke.passed) throw new Error("Runtime smoke suite failed")
		} else if (positionalArgs.length > 0 && !positionalArgs[0].startsWith("-")) {
			const prompt = positionalArgs.join(" ")
			const result = await lumi.tick({ prompt })
			const color =
				result.outcome === "completed" ? "\x1b[1;32m" : result.outcome === "cancelled" ? "\x1b[1;33m" : "\x1b[1;31m"
			console.log(
				`${color}[${result.outcome.toUpperCase()} · HEAV3NS Frame #${result.frameIndex}]\x1b[0m (${result.durationMs}ms)`,
			)
			console.log(result.response)
		} else {
			await startRepl(lumi)
		}
	})()
		.catch((err) => {
			console.error("HEAV3NS CLI execution failed:", err)
			process.exitCode = 1
		})
		.finally(async () => {
			if (stateManagerInitialized) {
				try {
					await StateManager.get().shutdown()
				} catch (error) {
					console.error("Could not flush HEAV3NS local state during shutdown:", error)
					process.exitCode = 1
				}
			}
			await workspaceOwner?.release()
		})
}
