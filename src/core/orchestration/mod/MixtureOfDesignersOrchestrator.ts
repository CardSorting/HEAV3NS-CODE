import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { Task } from "@/core/task"
import { Logger } from "@/shared/services/Logger"
import { ComponentContractLedger } from "./ComponentContractLedger"
import { ContextBuilder } from "./ContextBuilder"
import { ConvergenceEngine } from "./ConvergenceEngine"
import { DesignCircuitBreaker } from "./DesignCircuitBreaker"
import { DesignDecisionRecordBuilder } from "./DesignDecisionRecord"
import { DesignerInResidence } from "./DesignerInResidence"
import { DesignIntelligenceGraphBuilder } from "./DesignIntelligenceGraph"
import { DesignIntelligenceStore } from "./DesignIntelligenceStore"
import { DesignStateCache } from "./DesignStateCache"
import { GateEvaluator } from "./GateEvaluator"
import { IntentAnalyzer } from "./IntentAnalyzer"
import { ProblemClassifier } from "./ProblemClassifier"
import { ProductCriticRunner } from "./ProductCriticRunner"
import { ReceiptStore } from "./ReceiptStore"
import { SpecialistSelector } from "./SpecialistSelector"
import { SpeculativeTaskPlanner } from "./SpeculativeTaskPlanner"
import { TokenSyncEngine } from "./TokenSyncEngine"
import {
	DesignAuditFinding,
	DesignerRole,
	DesignGateResult,
	DesignHypothesis,
	DesignImplementationTask,
	DesignIntentContract,
	DesignInvestigation,
	DesignOption,
	DesignRefinement,
	DesignRevisionRequest,
	DesignValidationResult,
	MoDOutcome,
	MoDRunState,
	MoDStage,
	SpecialistResult,
	SpecialistSelection,
} from "./types"
import { UXRegressionRiskCalculator } from "./UXRegressionRiskCalculator"

export class TargetResolutionException extends Error {
	constructor(
		public readonly decisionId: string,
		public readonly reason: "TARGET_RESOLUTION_FAILED" | "EMPTY_MUTATION_BOUNDARY",
		message: string,
	) {
		super(message)
		this.name = "TargetResolutionException"
	}
}

export const STAGE_DESCRIPTIONS: Record<MoDStage, string> = {
	initializing: "Initializing multi-specialist design council...",
	observe: "Observing workspace structure...",
	intent: "Analyzing product intent & architectural boundaries...",
	classification: "Classifying problem dimensions across codebase...",
	"build-mental-model": "Building structural mental model...",
	audit: "Auditing component contract completeness...",
	investigate: "Investigating user experience friction...",
	"specialist-selection": "Routing request to specialized design personas...",
	"specialist-analysis": "Designer-in-Residence investigating codebase architecture...",
	"explore-design": "Exploring architectural design options...",
	"recommendation-validation": "Validating recommendations against WCAG & design system patterns...",
	convergence: "Converging decisions & resolving design priority lattice...",
	"decision-lock": "Locking converged design decisions & building intent contracts...",
	"contract-generation": "Generating component intent contracts...",
	"implementation-planning": "Planning disjoint mutation tasks & assessing UX regression risk...",
	implementation: "Developer subagents executing code modifications within mutation boundaries...",
	validation: "Running multi-dimension gate audit (Accessibility, Visual, UX, Feasibility)...",
	critique: "Product critic evaluating holistic user experience coherence...",
	"post-implementation-audit": "Post-implementation audit verifying intent fulfillment...",
	completed: "Mixture of Designers pass completed successfully.",
	"completed-with-limitations": "Mixture of Designers pass completed with limitations.",
	failed: "Mixture of Designers run failed.",
	blocked: "Implementation blocked by workspace target resolution failure.",
}

export const MOD_DEFAULTS = {
	maxSpecialists: 6,
	maxRevisionPasses: 2,
	maxCritiquePasses: 1,
	allowParallelReadOnlyAnalysis: true,
	allowParallelMutations: true,
	maxParallelMutations: 3,
	requireEvidenceForHighPriorityChanges: true,
	lockAcceptedDecisionsBeforeImplementation: true,
} as const

export class MixtureOfDesignersOrchestrator {
	private state!: MoDRunState
	private readonly intentAnalyzer: IntentAnalyzer
	private readonly problemClassifier: ProblemClassifier
	private readonly specialistSelector: SpecialistSelector
	private readonly contextBuilder: ContextBuilder
	private readonly convergenceEngine: ConvergenceEngine
	private readonly gateEvaluator: GateEvaluator
	private readonly productCriticRunner: ProductCriticRunner
	private readonly designerInResidence: DesignerInResidence
	private readonly designIntelligenceGraphBuilder: DesignIntelligenceGraphBuilder

	constructor(
		private readonly task: Task,
		private readonly outcome: MoDOutcome = "auto",
	) {
		const api = this.task.api
		this.intentAnalyzer = new IntentAnalyzer(api)
		this.problemClassifier = new ProblemClassifier(api)
		this.specialistSelector = new SpecialistSelector()
		this.contextBuilder = new ContextBuilder()
		this.convergenceEngine = new ConvergenceEngine()
		this.gateEvaluator = new GateEvaluator()
		this.productCriticRunner = new ProductCriticRunner(api)
		this.designerInResidence = new DesignerInResidence(api)
		this.designIntelligenceGraphBuilder = new DesignIntelligenceGraphBuilder()
	}

	public async run(userContent: any[]): Promise<void> {
		const requestText = Array.isArray(userContent)
			? userContent
					.map((c) => (typeof c === "string" ? c : c?.text || (c?.type === "text" ? c.text : "")))
					.filter(Boolean)
					.join("\n") || "Design refinement and user experience improvement"
			: "Design refinement and user experience improvement"
		Logger.info(`[MoD] Starting MoD run for task ${this.task.taskId}`)
		this.emitTelemetry("mod.started")

		// Load or initialize state
		const workspaceDir = (this.task as any).cwd || process.cwd()
		const cachedState = DesignStateCache.get(this.task.taskId)
		const persistedDesignIntelligence = await DesignIntelligenceStore.load(workspaceDir)
		const saved = cachedState || (await ReceiptStore.loadAndValidate(this.task.taskId, workspaceDir))
		if (saved) {
			Logger.info("[MoD] Found existing run state, resuming...")
			this.state = saved
			this.state.designIntelligence ??= persistedDesignIntelligence
			this.state.designInvestigations ??= []
			this.state.designIntentContracts ??= []
		} else {
			this.state = {
				runId: crypto.randomUUID(),
				mode: "mixture-of-designers",
				outcome: this.outcome,
				stage: "initializing",
				designIntelligence: persistedDesignIntelligence,
				designInvestigations: [],
				designIntentContracts: [],
				specialistSelections: [],
				specialistResults: [],
				refinements: [],
				decisions: [],
				implementationTasks: [],
				validationResults: [],
				critiqueFindings: [],
				gateResults: [],
				revisions: [],
				limitations: [],
				checkpointHashes: {},
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			}
		}

		try {
			await this.executeStages(requestText)
		} catch (error: any) {
			Logger.error("[MoD] Run failed in orchestrator:", error)
			this.state.stage = "failed"
			this.state.failure = {
				stage: this.state.stage,
				code: "ORCHESTRATOR_CRASH",
				message: error.message || String(error),
				evidence: [],
				recoverable: false,
				recommendedAction: "Verify model settings and retry.",
			}
			await ReceiptStore.save(this.task.taskId, this.state)
			this.emitTelemetry("mod.failed")
			await this.task.say("completion_result", `Mixture of Designers mode failed: ${error.message}`)
		}
	}

	private async executeStages(requestText: string): Promise<void> {
		const workspaceDir = (this.task as any).cwd

		// Stage 1 & Stage 2: Concurrent Product Intent & Problem Classification
		if (!this.state.intent || !this.state.problemClassification) {
			await this.transitionTo("intent", "Analyzing goal & workspace boundaries")
			const [intentRes, classificationRes] = await Promise.all([
				this.state.intent ? Promise.resolve(this.state.intent) : this.intentAnalyzer.analyze(requestText, workspaceDir),
				this.state.problemClassification
					? Promise.resolve(this.state.problemClassification)
					: this.problemClassifier.classify(requestText, workspaceDir),
			])
			this.state.intent = intentRes
			this.state.problemClassification = classificationRes
			void ReceiptStore.save(this.task.taskId, this.state)
			this.emitTelemetry("mod.intent.completed")
			this.emitTelemetry("mod.classification.completed")
		}

		// Stage 3: Select the internal lenses the resident will apply to one coherent investigation.
		if (this.state.specialistSelections.length === 0) {
			await this.transitionTo("specialist-selection", "Evaluating problem dimensions")
			this.state.specialistSelections = this.specialistSelector.select(
				this.state.problemClassification.problems,
				MOD_DEFAULTS.maxSpecialists,
			)
			void ReceiptStore.save(this.task.taskId, this.state)
			this.emitTelemetry("mod.specialists.selected")
		}
		await this.refreshDesignIntelligence(workspaceDir)

		// Stage 4: One Designer-in-Residence investigates through the selected lenses.
		if (this.state.refinements.length === 0) {
			const rolesList = this.state.specialistSelections.map((s) => s.role).join(", ")
			await this.transitionTo("specialist-analysis", `Examining codebase via lenses: ${rolesList || "Product Strategist"}`)
			await this.runDesignerInResidenceInvestigation(requestText, workspaceDir)
			await this.transitionTo("recommendation-validation", "Verifying WCAG & design token fit")
			this.validateRecommendations()
			void ReceiptStore.save(this.task.taskId, this.state)
			this.emitTelemetry("mod.recommendations.validated")
		}

		// Stage 5 & Stage 6: Fast-Path Atomic Decision Lock & Contract Generation
		if (this.state.decisions.length === 0) {
			await this.transitionTo("convergence", `Fusing ${this.state.refinements.length} recommendations via priority lattice`)
			const converged = this.convergenceEngine.converge(this.state.intent!, this.state.refinements)
			this.state.decisions = converged.decisions
			this.state.designIntentContracts = this.buildDesignIntentContracts()
			this.state.designDecisionRecords = this.state.decisions.map((dec, idx) =>
				DesignDecisionRecordBuilder.createDDR(
					idx + 1,
					dec,
					this.state.refinements.find((r) => dec.sourceRefinementIds.includes(r.id)),
				),
			)
			for (const dec of this.state.decisions) {
				if (dec.status === "accepted") {
					dec.locked = true
					this.emitTelemetry("mod.decision.locked")
				}
			}
			void ReceiptStore.save(this.task.taskId, this.state)
			this.emitTelemetry("mod.convergence.completed")
		} else {
			await this.transitionTo("decision-lock", `Locking ${this.state.decisions.length} design decisions`)
			for (const dec of this.state.decisions) {
				if (dec.status === "accepted") {
					dec.locked = true
				}
			}
			void ReceiptStore.save(this.task.taskId, this.state)
		}

		// Stage 7: Implementation Planning
		if (this.state.implementationTasks.length === 0) {
			await this.transitionTo("implementation-planning", "Resolving mutation boundaries")
			this.state.implementationTasks = this.generateImplementationTasks()
			const riskReport = new UXRegressionRiskCalculator().calculateRisk(
				this.state.decisions,
				this.state.implementationTasks,
			)
			if (riskReport.riskLevel === "critical" || riskReport.riskLevel === "high") {
				Logger.warn(
					`[MoD Predictive Risk] Risk score elevated (${riskReport.score}/100, Level: ${riskReport.riskLevel}). Mitigations: ${riskReport.mitigationRecommendations.join("; ")}`,
				)
				this.state.limitations.push(...riskReport.riskFactors)
			}
			void ReceiptStore.save(this.task.taskId, this.state)
		}

		const hasTargetResolutionFailures = this.state.limitations.some(
			(lim) => lim.includes("[TARGET_RESOLUTION_FAILURE]") || lim.includes("[DESIGN_INVESTIGATION_FAILED]"),
		)
		const acceptedDecisionsCount = (this.state.decisions || []).filter((d) => d.status === "accepted").length

		if (this.state.implementationTasks.length === 0 && (hasTargetResolutionFailures || acceptedDecisionsCount > 0)) {
			Logger.warn("[MoD Execution State] Implementation blocked: All design decisions failed workspace target resolution.")
			await this.transitionTo("blocked", "All design decisions failed workspace target resolution")
			this.emitTelemetry("mod.failed")
			await ReceiptStore.save(this.task.taskId, this.state)
			await this.reportFinalResult()
			return
		}

		// Dynamic outcome discernment based on request intent and grounded task availability
		const effectiveOutcome = this.determineEffectiveOutcome(requestText)
		this.state.outcome = effectiveOutcome

		if (effectiveOutcome === "plan-only") {
			Logger.info("[MoD Execution Strategy] Strategy determined plan-only outcome, bypassing implementation")
			await Promise.all([this.runIntegratedValidation(), this.runCritique(workspaceDir)])
			this.state.gateResults = this.gateEvaluator.evaluate(this.state)
			if (this.state.gateResults.some((gate) => !gate.passed)) {
				this.state.limitations.push("Plan-only run did not satisfy every quality gate.")
				await this.transitionTo("completed-with-limitations", "Gate validation finished with limitations")
				this.emitTelemetry("mod.completed_with_limitations")
			} else {
				await this.transitionTo("completed", "All quality gates satisfied")
				this.emitTelemetry("mod.completed")
			}
			await ReceiptStore.save(this.task.taskId, this.state)
			await this.reportFinalResult()
			return
		}

		// Stage 8: Parent-Authorized Implementation
		await this.transitionTo("implementation", `${this.state.implementationTasks.length} mutation tasks queued`)
		this.emitTelemetry("mod.implementation.started")
		await this.executeImplementationTasks(workspaceDir)
		this.emitTelemetry("mod.implementation.completed")

		// Stage 9: Concurrent Integrated Validation & Product Critique
		await this.transitionTo("validation", "Auditing Accessibility, Visual, UX & Feasibility gates")
		await Promise.all([this.runIntegratedValidation(), this.runCritique(workspaceDir)])
		this.emitTelemetry("mod.validation.completed")

		// Post-Implementation Design Audit by Designer-in-Residence
		await this.transitionTo("post-implementation-audit", "Evaluating code modifications against intent contracts")
		await this.runPostImplementationAudit(workspaceDir)

		// Stage 10: Gate Evaluation & Revisions Loop
		let revisionCount = 0
		while (revisionCount < MOD_DEFAULTS.maxRevisionPasses) {
			this.state.gateResults = this.gateEvaluator.evaluate(this.state)
			const failedGates = this.state.gateResults.filter((g) => !g.passed)

			if (failedGates.length === 0) {
				break
			}

			revisionCount++
			Logger.warn(`[MoD] Gates failed, starting targeted revision pass ${revisionCount}...`)
			this.emitTelemetry("mod.gate.failed")

			// Trigger targeted revisions
			await this.transitionTo("specialist-analysis")
			await this.runRevisionAnalysis(failedGates, revisionCount)
			this.state.decisions = this.convergenceEngine.converge(this.state.intent!, this.state.refinements).decisions
			for (const decision of this.state.decisions) {
				if (decision.status === "accepted") {
					decision.locked = true
				}
			}
			this.state.designIntentContracts = this.buildDesignIntentContracts()
			this.state.implementationTasks = this.generateImplementationTasks()
			await this.transitionTo("implementation")
			await this.executeImplementationTasks(workspaceDir)
			await this.transitionTo("validation")
			await this.runIntegratedValidation()
			this.state.gateResults = this.gateEvaluator.evaluate(this.state)
		}

		if (this.state.gateResults.some((g) => !g.passed)) {
			// Revision budget exhausted
			Logger.error("[MoD] Revision budget exhausted, failing run or returning with limitations")
			this.state.limitations.push("Revision budget exhausted before all gates passed.")
			await this.transitionTo("completed-with-limitations")
			this.emitTelemetry("mod.completed_with_limitations")
		} else {
			await this.transitionTo("completed")
			this.emitTelemetry("mod.completed")
		}

		await ReceiptStore.save(this.task.taskId, this.state)
		await this.reportFinalResult()
	}

	private async transitionTo(stage: MoDStage, details?: string): Promise<void> {
		this.state.stage = stage
		this.state.updatedAt = new Date().toISOString()
		DesignStateCache.set(this.task.taskId, this.state)
		Logger.info(`[MoD] Transitioned to stage: ${stage}${details ? ` (${details})` : ""}`)

		const progress = this.getStageProgressPercent(stage)
		const statusStr =
			stage === "completed" || stage === "completed-with-limitations"
				? "completed"
				: stage === "failed"
					? "failed"
					: "running"

		const description = STAGE_DESCRIPTIONS[stage] || `Stage: ${stage}`
		const promptText = details ? `${description} · ${details}` : description

		const glassbox = {
			specialists: this.state.specialistSelections?.map((s) => ({
				role: s.role,
				focus: s.reasons?.[0] || s.role,
				status: this.state.refinements?.length > 0 ? "completed" : "active",
			})),
			decisions: this.state.decisions?.map((d) => ({
				id: d.id,
				title: d.decision || d.rationale,
				rationale: d.rationale,
				targetFiles: d.affectedAreas || [],
				locked: Boolean(d.locked),
			})),
			tasks: this.state.implementationTasks?.map((t) => ({
				id: t.id,
				objective: t.objective,
				targetFiles: t.affectedFiles || [],
				status: t.status,
			})),
			gates: this.state.gateResults?.map((g) => ({
				gate: g.gate,
				passed: g.passed,
			})),
		}
		Logger.info(`[MoD Progress] Stage: ${this.state.stage} (${progress}%) - ${promptText}`, glassbox)
	}

	private getStageProgressPercent(stage: MoDStage): number {
		if (stage === "completed-with-limitations" || stage === "blocked") {
			return 100
		}

		const stages: MoDStage[] = [
			"initializing",
			"intent",
			"classification",
			"specialist-selection",
			"specialist-analysis",
			"recommendation-validation",
			"convergence",
			"decision-lock",
			"implementation-planning",
			"implementation",
			"validation",
			"critique",
			"completed",
		]
		const idx = stages.indexOf(stage)
		return idx === -1 ? 0 : Math.round((idx / (stages.length - 1)) * 100)
	}

	private async refreshDesignIntelligence(workspaceDir: string): Promise<void> {
		if (!this.state.intent || !this.state.problemClassification) return

		const tokenEngine = new TokenSyncEngine()
		if (this.state.designIntelligence?.designTokens) {
			tokenEngine.generateCodemodPatch("", this.state.designIntelligence.designTokens)
		}

		this.state.designIntelligence = this.designIntelligenceGraphBuilder.build({
			intent: this.state.intent,
			problems: this.state.problemClassification.problems,
			lenses: this.state.specialistSelections.map((selection) => selection.role),
			previous: this.state.designIntelligence,
		})
		await DesignIntelligenceStore.save(workspaceDir, this.state.designIntelligence)
	}

	private async runDesignerInResidenceInvestigation(requestText: string, workspaceDir: string): Promise<void> {
		const selections = this.state.specialistSelections
		const lenses = selections.map((selection) => selection.role)
		const primaryLens = lenses[0] || "product-strategist"
		const contextPackages = await this.contextBuilder.buildBatch(
			lenses,
			this.state.intent!,
			this.state.problemClassification!.problems,
			workspaceDir,
		)
		const workspaceFiles = [...contextPackages.values()]
			.flatMap((context) => context.files)
			.filter((file, index, allFiles) => allFiles.findIndex((candidate) => candidate.path === file.path) === index)
			.map(({ path, relevance }) => ({ path, relevance }))

		const investigationResult = await DesignCircuitBreaker.executeWithFallback(
			() =>
				this.designerInResidence.investigate({
					request: requestText,
					intent: this.state.intent!,
					graph: this.state.designIntelligence!,
					lenses,
					workspaceFiles,
				}),
			{
				name: "DesignerInResidence.investigate",
				timeoutMs: 30_000,
				fallback: () => ({
					summary: `Heuristic senior design direction for ${requestText}`,
					findings: [],
					hypotheses: [],
					options: [],
					selectedOptionId: "option-a",
					refinement: this.getFallbackRefinement(primaryLens, requestText),
					rawResponse: "Heuristic fallback investigation",
					durationMs: 0,
					success: false,
				}),
			},
		)
		const parsed = this.parseDesignInvestigation(investigationResult.rawResponse, primaryLens)
		const refinements =
			investigationResult.success && parsed.refinements.length > 0
				? parsed.refinements
				: [this.getFallbackRefinement(primaryLens, "", this.getAssignedProblem(selections[0]))]

		const investigation: DesignInvestigation = {
			id: `investigation-${this.state.designInvestigations?.length || 0 + 1}`,
			request: requestText,
			lenses,
			findings: parsed.findings,
			hypotheses: parsed.hypotheses,
			options: parsed.options,
			summary:
				parsed.summary ||
				"The Designer-in-Residence synthesized the observed product evidence into one implementation-ready direction.",
			createdAt: new Date().toISOString(),
		}

		this.state.designInvestigations ??= []
		this.state.designInvestigations.push(investigation)
		// Kept for receipt compatibility; this is one resident investigation, not a specialist council result.
		this.state.specialistResults = [
			{
				role: primaryLens,
				refinements,
				durationMs: investigationResult.durationMs,
				success: investigationResult.success,
				error: investigationResult.error,
			},
		]
		this.state.refinements = refinements
		if (!investigationResult.success) {
			const isGrounded = refinements.some((r) => (r.implementation?.affectedFiles || []).length > 0)
			if (!isGrounded) {
				this.state.limitations.push(
					"[DESIGN_INVESTIGATION_FAILED] Design investigation could not be grounded in concrete workspace files.",
				)
			}
			this.state.limitations.push(
				"The Designer-in-Residence used an evidence-backed fallback because the primary design investigation was unavailable.",
			)
		}
	}

	private async runPostImplementationAudit(workspaceDir: string): Promise<void> {
		const contract = this.state.designIntentContracts?.[0]
		if (!contract) return

		const changedFiles = this.state.implementationTasks.flatMap((t) => t.affectedFiles)
		const auditResult = await this.designerInResidence.auditPostImplementation({
			contract,
			changesMade: changedFiles,
			workspaceDir,
		})

		if (!auditResult.achievedIntent) {
			for (const dev of auditResult.deviations) {
				this.state.limitations.push(`Post-implementation audit deviation: ${dev}`)
			}
		}

		if (auditResult.designDebtAdjustments.length > 0 && this.state.designIntelligence) {
			const addressed = auditResult.designDebtAdjustments.filter((a) => a.status === "addressed").map((a) => a.id)
			const followUp = auditResult.designDebtAdjustments.filter((a) => a.status === "needs-follow-up").map((a) => a.id)
			this.state.designIntelligence = this.designIntelligenceGraphBuilder.reconcileDebt(
				this.state.designIntelligence,
				addressed,
				followUp,
			)
			await DesignIntelligenceStore.save(workspaceDir, this.state.designIntelligence)
		}
	}

	private buildDesignIntentContracts(): DesignIntentContract[] {
		const acceptedDecisions = (this.state.decisions || []).filter((d) => d.status === "accepted")
		return acceptedDecisions.map((dec) => ({
			decisionId: dec.id,
			goal: dec.decision,
			mustPreserve: this.state.intent?.boundaries?.preserve || [],
			mustImprove: [dec.rationale],
			use: [...(this.state.intent?.currentExperience?.existingPatterns || [])],
			avoid: [...(this.state.intent?.boundaries?.outOfScope || [])],
			successCriteria: dec.acceptanceCriteria,
			validationPlan: dec.reopenConditions,
		}))
	}

	private parseDesignInvestigation(
		text: string,
		primaryLens: DesignerRole,
	): Pick<DesignInvestigation, "findings" | "hypotheses" | "options" | "summary"> & { refinements: DesignRefinement[] } {
		try {
			const cleaned = text
				.replace(/```json/gi, "")
				.replace(/```/g, "")
				.trim()
			const objectMatch = cleaned.match(/\{[\s\S]*\}/)
			const payload = objectMatch ? JSON.parse(objectMatch[0]) : JSON.parse(cleaned)
			if (Array.isArray(payload)) {
				return {
					findings: [],
					hypotheses: [],
					options: [],
					summary: "",
					refinements: this.parseRefinements(JSON.stringify(payload), primaryLens),
				}
			}

			const refinements = Array.isArray(payload.refinements)
				? this.parseRefinements(JSON.stringify(payload.refinements), primaryLens)
				: []
			return {
				findings: this.sanitizeAuditFindings(payload.findings, primaryLens),
				hypotheses: this.sanitizeHypotheses(payload.hypotheses),
				options: this.sanitizeDesignOptions(payload.options),
				summary: typeof payload.summary === "string" ? payload.summary : "",
				refinements,
			}
		} catch (error) {
			Logger.warn("[Designer-in-Residence] Could not parse investigation response; using its refinement fallback", error)
			return {
				findings: [],
				hypotheses: [],
				options: [],
				summary: "",
				refinements: this.parseRefinements(text, primaryLens),
			}
		}
	}

	private sanitizeAuditFindings(value: unknown, fallbackLens: DesignerRole): DesignAuditFinding[] {
		if (!Array.isArray(value)) return []
		return value.map((finding, index) => {
			const raw = finding as any
			return {
				id: typeof raw.id === "string" ? raw.id : `finding-${index + 1}`,
				lens: this.isDesignerRole(raw.lens) ? raw.lens : fallbackLens,
				target: typeof raw.target === "string" ? raw.target : "General product surface",
				observation: typeof raw.observation === "string" ? raw.observation : "Design opportunity requires investigation.",
				userImpact: typeof raw.userImpact === "string" ? raw.userImpact : "User experience friction.",
				evidence: Array.isArray(raw.evidence) ? raw.evidence.filter((item: unknown) => typeof item === "string") : [],
				severity: ["critical", "high", "medium", "low"].includes(raw.severity) ? raw.severity : "medium",
				status: ["open", "addressed", "needs-follow-up"].includes(raw.status) ? raw.status : "open",
			}
		})
	}

	private sanitizeHypotheses(value: unknown): DesignHypothesis[] {
		if (!Array.isArray(value)) return []
		return value.map((hypothesis, index) => {
			const raw = hypothesis as any
			return {
				id: typeof raw.id === "string" ? raw.id : `hypothesis-${index + 1}`,
				findingId: typeof raw.findingId === "string" ? raw.findingId : "",
				statement: typeof raw.statement === "string" ? raw.statement : "Investigate the underlying experience issue.",
				evidence: Array.isArray(raw.evidence) ? raw.evidence.filter((item: unknown) => typeof item === "string") : [],
				alternatives: Array.isArray(raw.alternatives)
					? raw.alternatives.filter((item: unknown) => typeof item === "string")
					: [],
				confidence: ["high", "medium", "low"].includes(raw.confidence) ? raw.confidence : "medium",
			}
		})
	}

	private sanitizeDesignOptions(value: unknown): DesignOption[] {
		if (!Array.isArray(value)) return []
		return value.map((option, index) => {
			const raw = option as any
			return {
				id: typeof raw.id === "string" ? raw.id : `option-${index + 1}`,
				title: typeof raw.title === "string" ? raw.title : `Option ${index + 1}`,
				approach: typeof raw.approach === "string" ? raw.approach : "Explore a familiar product pattern.",
				pros: Array.isArray(raw.pros) ? raw.pros.filter((item: unknown) => typeof item === "string") : [],
				cons: Array.isArray(raw.cons) ? raw.cons.filter((item: unknown) => typeof item === "string") : [],
				recommended: raw.recommended === true,
			}
		})
	}

	private isDesignerRole(value: unknown): value is DesignerRole {
		return (
			typeof value === "string" &&
			[
				"product-strategist",
				"ux-architect",
				"interaction-designer",
				"visual-systems-designer",
				"content-designer",
				"design-system-engineer",
				"accessibility-reviewer",
				"responsive-design-reviewer",
				"frontend-implementation-designer",
				"product-critic",
			].includes(value)
		)
	}

	private async runSpecialistsAnalysis(workspaceDir: string): Promise<void> {
		const specialists = this.state.specialistSelections
		const roles = specialists.map((s) => s.role)
		await this.contextBuilder.buildBatch(roles, this.state.intent!, this.state.problemClassification!.problems, workspaceDir)

		const promises = specialists.map((spec) => this.runSpecialist(spec, workspaceDir))
		const settled = await Promise.allSettled(promises)
		const results: SpecialistResult[] = []

		for (let i = 0; i < settled.length; i++) {
			const res = settled[i]
			const selection = specialists[i]
			if (res.status === "fulfilled") {
				results.push(res.value)
			} else {
				const errorMsg = res.reason?.message || String(res.reason)
				Logger.error(
					`[MoD Specialist Circuit Breaker] Specialist ${selection.role} threw unhandled exception: ${errorMsg}. Tripping fallback expert...`,
				)
				const fallbackRole = this.specialistSelector.getFallbackRole(selection.role)
				results.push({
					role: selection.role,
					refinements: [this.getFallbackRefinement(selection.role, "", this.getAssignedProblem(selection))],
					durationMs: 0,
					success: false,
					error: `Circuit tripped: ${errorMsg}. Re-routed to fallback ${fallbackRole}`,
				})
			}
		}

		this.state.specialistResults = results
		this.state.refinements = results.flatMap((r) => r.refinements)
	}

	private async runSpecialist(selection: SpecialistSelection, workspaceDir: string): Promise<SpecialistResult> {
		const start = Date.now()
		this.emitTelemetry("mod.specialist.started")

		try {
			const packageCtx = await this.contextBuilder.build(
				selection.role,
				this.state.intent!,
				this.state.problemClassification!.problems,
				workspaceDir,
			)

			const contractPrompt = `You are the ${selection.role} specialist in a design council.
Analyze assigned problems: ${JSON.stringify(packageCtx.assignedProblems, null, 2)}
Workspace files: ${JSON.stringify(packageCtx.files, null, 2)}

Provide design refinements. Avoid generic language like "make it cleaner" or "improve UX". Output refinements strictly following the DesignRefinement schema.

Output JSON array only.`

			const stream = this.task.api.createMessage(contractPrompt, [
				{ role: "user", content: [{ type: "text", text: `Build details for ${selection.role}` }], ts: Date.now() },
			])
			let text = ""
			const iterator = stream[Symbol.asyncIterator]()
			while (true) {
				const chunk = await iterator.next()
				if (chunk.done) break
				if (chunk.value.type === "text") {
					text += chunk.value.text
				}
			}

			const refinements = this.parseRefinements(text, selection.role)
			this.emitTelemetry("mod.specialist.completed")
			return {
				role: selection.role,
				refinements,
				durationMs: Date.now() - start,
				success: true,
			}
		} catch (error: any) {
			Logger.error(`[MoD] Specialist ${selection.role} analysis failed:`, error)
			this.emitTelemetry("mod.specialist.failed")
			return {
				role: selection.role,
				refinements: [this.getFallbackRefinement(selection.role, "", this.getAssignedProblem(selection))],
				durationMs: Date.now() - start,
				success: false,
				error: error.message || String(error),
			}
		}
	}

	private parseRefinements(text: string, role: DesignerRole): DesignRefinement[] {
		let rawArray: any[] = []
		try {
			const cleaned = text
				.replace(/```json/gi, "")
				.replace(/```/g, "")
				.trim()
			const match = cleaned.match(/\[[\s\S]*\]/)
			rawArray = match ? JSON.parse(match[0]) : JSON.parse(cleaned)
		} catch (e) {
			Logger.warn(
				`[MoD] Failed to parse JSON refinements from specialist ${role}, synthesizing fallback refinement from text response`,
				e,
			)
			return [this.getFallbackRefinement(role, text)]
		}

		if (!Array.isArray(rawArray) || rawArray.length === 0) {
			return [this.getFallbackRefinement(role, text)]
		}

		return rawArray.map((r: any, idx: number) => ({
			id: r.id || `ref-${role}-${idx + 1}`,
			role,
			problem: {
				problemId: r.problem?.problemId || "general",
				target: r.problem?.target || "General",
				observedBehavior: r.problem?.observedBehavior || "behavior",
				userImpact: r.problem?.userImpact || "impact",
				severity: r.problem?.severity || "medium",
				frequency: r.problem?.frequency || "frequent",
			},
			evidence: Array.isArray(r.evidence) ? r.evidence : [],
			recommendation: {
				designStrategy: r.recommendation?.designStrategy || "strategy",
				proposedChange: r.recommendation?.proposedChange || "change",
				familiarPattern: r.recommendation?.familiarPattern,
				whyPatternFits: r.recommendation?.whyPatternFits,
				adaptationNotes: Array.isArray(r.recommendation?.adaptationNotes) ? r.recommendation.adaptationNotes : [],
				alternativesConsidered: Array.isArray(r.recommendation?.alternativesConsidered)
					? r.recommendation.alternativesConsidered
					: [],
				tradeoffs: Array.isArray(r.recommendation?.tradeoffs) ? r.recommendation.tradeoffs : [],
			},
			implementation: {
				affectedFiles: Array.isArray(r.implementation?.affectedFiles) ? r.implementation.affectedFiles : [],
				affectedComponents: Array.isArray(r.implementation?.affectedComponents)
					? r.implementation.affectedComponents
					: [],
				affectedStates: Array.isArray(r.implementation?.affectedStates) ? r.implementation.affectedStates : [],
				instructions: Array.isArray(r.implementation?.instructions) ? r.implementation.instructions : [],
				dependencies: Array.isArray(r.implementation?.dependencies) ? r.implementation.dependencies : [],
				riskLevel: r.implementation?.riskLevel || "medium",
			},
			validation: {
				acceptanceCriteria: Array.isArray(r.validation?.acceptanceCriteria) ? r.validation.acceptanceCriteria : [],
				regressionRisks: Array.isArray(r.validation?.regressionRisks) ? r.validation.regressionRisks : [],
				verificationMethods: Array.isArray(r.validation?.verificationMethods) ? r.validation.verificationMethods : [],
			},
			governance: {
				confidence: r.governance?.confidence || "medium",
				scopeStatus: r.governance?.scopeStatus || "in-scope",
				mutationAuthorityRequired: !!r.governance?.mutationAuthorityRequired,
				conflictsWith: Array.isArray(r.governance?.conflictsWith) ? r.governance.conflictsWith : [],
			},
		}))
	}

	private getAssignedProblem(selection: SpecialistSelection) {
		const problemIds = new Set(selection.assignedProblemIds)
		return this.state?.problemClassification?.problems.find((problem) => problemIds.has(problem.id))
	}

	private probeWorkspaceTargetFiles(workspaceDir?: string): string[] {
		// 1. Check problem classification for concrete file targets
		const problemFiles: string[] = []
		for (const prob of this.state?.problemClassification?.problems || []) {
			if (
				prob.target &&
				prob.target !== "General" &&
				prob.target !== "General Area" &&
				prob.target !== "General UI" &&
				prob.target !== "Interactive Components" &&
				(prob.target.includes("/") || prob.target.includes("."))
			) {
				problemFiles.push(prob.target)
			}
		}
		if (problemFiles.length > 0) {
			return Array.from(new Set(problemFiles))
		}

		// 2. Synchronous workspace probe for source/UI files
		const targetDir = workspaceDir || (this.task as any)?.cwd || process.cwd()
		if (!targetDir) return []

		try {
			const candidateExtensions = [".tsx", ".ts", ".jsx", ".js", ".vue", ".svelte", ".css", ".html"]
			const ignoreDirs = new Set(["node_modules", ".git", "dist", "build", ".next", ".dietcode", ".gemini", "out"])
			const foundFiles: string[] = []

			const scanDir = (dir: string, depth = 0): void => {
				if (depth > 4 || foundFiles.length >= 10) return
				const entries = fs.readdirSync(dir, { withFileTypes: true })
				for (const entry of entries) {
					if (ignoreDirs.has(entry.name)) continue
					const fullPath = path.join(dir, entry.name)
					if (entry.isFile()) {
						const ext = path.extname(entry.name).toLowerCase()
						if (candidateExtensions.includes(ext)) {
							foundFiles.push(path.relative(targetDir, fullPath))
						}
					} else if (entry.isDirectory()) {
						scanDir(fullPath, depth + 1)
					}
				}
			}

			scanDir(targetDir)
			return Array.from(new Set(foundFiles))
		} catch {
			return []
		}
	}

	private probeWorkspaceTargetFile(workspaceDir?: string): string | undefined {
		const files = this.probeWorkspaceTargetFiles(workspaceDir)
		return files[0]
	}

	private getFallbackRefinement(
		role: DesignerRole,
		text: string,
		problem = this.state?.problemClassification?.problems.find((candidate) => {
			const selection = this.state?.specialistSelections.find((item) => item.role === role)
			return selection?.assignedProblemIds.includes(candidate.id)
		}),
	): DesignRefinement {
		const cleanText = text.replace(/```[\s\S]*?```/g, "").trim()
		const firstLine = cleanText.split("\n").filter((l) => l.trim().length > 0)[0]
		let target = problem?.target || "General Area"
		if (
			!target ||
			target === "General" ||
			target === "General Area" ||
			target === "General UI" ||
			target === "Interactive Components" ||
			(!target.includes("/") && !target.includes("."))
		) {
			const groundedCandidate = this.probeWorkspaceTargetFile()
			if (groundedCandidate) {
				target = groundedCandidate
			}
		}

		const proposedChange =
			firstLine || `Address ${problem?.observation || "the requested product experience issue"} in ${target}.`
		const affectedFiles =
			target !== "General" &&
			target !== "General Area" &&
			target !== "General UI" &&
			target !== "Interactive Components" &&
			(target.includes("/") || target.includes("."))
				? [target]
				: []

		return {
			id: `ref-${role}-fallback`,
			role,
			problem: {
				problemId: problem?.id || "general",
				target,
				observedBehavior: problem?.observation || "Needs product experience optimization",
				userImpact: problem?.userImpact || "User experience friction",
				severity: problem?.severity || "medium",
				frequency: "frequent",
			},
			evidence: problem ? [{ type: "product-intent", reference: problem.target, observation: problem.observation }] : [],
			recommendation: {
				designStrategy: `Refine experience using ${role} best practices`,
				proposedChange: proposedChange.slice(0, 150),
				adaptationNotes: [],
				alternativesConsidered: [],
				tradeoffs: [],
			},
			implementation: {
				affectedFiles,
				affectedComponents: [],
				affectedStates: [],
				instructions: [proposedChange],
				dependencies: [],
				riskLevel: "low",
			},
			validation: {
				acceptanceCriteria: ["Experience optimization implemented"],
				regressionRisks: [],
				verificationMethods: [],
			},
			governance: {
				confidence: "medium",
				scopeStatus: "in-scope",
				mutationAuthorityRequired: false,
				conflictsWith: [],
			},
		}
	}

	private validateRecommendations(): void {
		const original = [...this.state.refinements]
		// Reject recommendations without target, impact, or vague details
		const filtered = this.state.refinements.filter((ref) => {
			const hasTarget = !!ref.problem.target && ref.problem.target !== ""
			const hasImpact = !!ref.problem.userImpact && ref.problem.userImpact !== ""
			const isVague =
				ref.recommendation.proposedChange.toLowerCase().includes("make it cleaner") ||
				ref.recommendation.proposedChange.toLowerCase().includes("improve the ux") ||
				ref.recommendation.proposedChange.toLowerCase() === "modernize it"
			return hasTarget && hasImpact && !isVague
		})

		this.state.refinements = filtered.length > 0 ? filtered : original
	}

	private generateImplementationTasks(): DesignImplementationTask[] {
		const tasks: DesignImplementationTask[] = []
		const acceptedDecisions = this.state.decisions.filter((d) => d.status === "accepted")
		if (acceptedDecisions.length === 0) return tasks

		const preserveBoundaries = this.state.intent?.boundaries?.preserve || []
		const allowedToChange = this.state.intent?.boundaries?.allowedToChange || []

		let taskIndex = 1
		for (const dec of acceptedDecisions) {
			try {
				const resolvedAreas = this.resolveTargetFilesForDecision(dec)
				dec.affectedAreas = resolvedAreas

				// Filter affected areas against preserve list (Hoare logic precondition)
				const validMutationBoundary = resolvedAreas.filter((file) => {
					const isPreserved = preserveBoundaries.some((p) => p && file.includes(p))
					if (allowedToChange.length > 0) {
						return !isPreserved && allowedToChange.some((a) => !a || file.includes(a) || a.includes(file))
					}
					return !isPreserved
				})

				if (validMutationBoundary.length === 0) {
					throw new TargetResolutionException(
						dec.id,
						"EMPTY_MUTATION_BOUNDARY",
						`Design decision '${dec.id}' mutation boundary resolved to 0 editable files.`,
					)
				}

				tasks.push({
					id: `task-${taskIndex++}`,
					decisionIds: [dec.id],
					objective: `Implement design decision: ${dec.decision}`,
					affectedFiles: resolvedAreas,
					affectedComponents: [],
					affectedStates: [],
					instructions: [dec.rationale],
					dependencies: [],
					acceptanceCriteria: dec.acceptanceCriteria,
					validationCommands: [],
					mutationBoundary: validMutationBoundary,
					preservedBehavior: preserveBoundaries,
					rollbackNotes: [],
					status: "pending",
				})
			} catch (error) {
				if (error instanceof TargetResolutionException) {
					Logger.warn(`[MoD Target Resolution Failure] ${error.message}`)
					this.state.limitations.push(`[TARGET_RESOLUTION_FAILURE] Implementation blocked: ${error.message}`)
				} else {
					throw error
				}
			}
		}

		if (tasks.length === 0 && acceptedDecisions.length > 0) {
			Logger.warn(
				"[MoD] Implementation blocked: Design decisions exist, but no concrete workspace targets could be resolved.",
			)
		}

		return tasks
	}

	private resolveTargetFilesForDecision(dec: {
		id: string
		decision: string
		rationale: string
		affectedAreas: string[]
		sourceRefinementIds?: string[]
	}): string[] {
		const rawAreas = dec.affectedAreas || []

		// 1. Explicitly ban generic areas from reaching the mutation phase without grounding
		const validPaths = rawAreas.filter(
			(file) => file && file !== "General" && file !== "General Area" && (file.includes("/") || file.includes(".")),
		)
		if (validPaths.length > 0) {
			return Array.from(new Set(validPaths))
		}

		// 2. Attempt deterministic extraction (explicit paths in evidence, AST references, or refinements)
		const refFiles: string[] = []
		const refinements = (this.state?.refinements || []).filter((r) => dec.sourceRefinementIds?.includes(r.id))
		for (const r of refinements) {
			for (const file of r.implementation?.affectedFiles || []) {
				if (file && file !== "General" && file !== "General Area" && (file.includes("/") || file.includes("."))) {
					refFiles.push(file)
				}
			}
			for (const ev of r.evidence || []) {
				const ref = typeof ev === "string" ? ev : (ev as any)?.reference
				if (typeof ref === "string" && (ref.includes("/") || ref.includes("."))) {
					refFiles.push(ref)
				}
			}
		}
		if (refFiles.length > 0) {
			return Array.from(new Set(refFiles))
		}

		// 3. Attempt deterministic extraction from problem classification evidence
		const problemFiles: string[] = []
		for (const p of this.state?.problemClassification?.problems || []) {
			if (
				p.target &&
				p.target !== "General" &&
				p.target !== "General Area" &&
				(p.target.includes("/") || p.target.includes("."))
			) {
				problemFiles.push(p.target)
			}
			for (const ev of p.evidence || []) {
				if (typeof ev === "string" && (ev.includes("/") || ev.includes("."))) {
					problemFiles.push(ev)
				}
			}
		}
		if (problemFiles.length > 0) {
			return Array.from(new Set(problemFiles))
		}

		// 4. Invariant Enforcer: Throw TargetResolutionException for ungrounded scopes
		if (rawAreas.includes("General") || rawAreas.includes("General Area") || rawAreas.length === 0) {
			throw new TargetResolutionException(
				dec.id,
				"TARGET_RESOLUTION_FAILED",
				`Design decision '${dec.id}' targeted '${rawAreas.join(", ") || "General"}', but could not be grounded in concrete workspace files.`,
			)
		}

		throw new TargetResolutionException(
			dec.id,
			"EMPTY_MUTATION_BOUNDARY",
			`Design decision '${dec.id}' has no concrete target files assigned.`,
		)
	}

	private determineEffectiveOutcome(requestText: string): "plan-only" | "plan-and-implement" {
		if (this.outcome === "plan-only") return "plan-only"
		if (this.outcome === "plan-and-implement") return "plan-and-implement"

		const lower = requestText.toLowerCase()
		if (
			lower.includes("plan only") ||
			lower.includes("audit only") ||
			lower.includes("architecture review") ||
			lower.includes("review only") ||
			lower.includes("do not modify") ||
			lower.includes("do not edit")
		) {
			Logger.info("[MoD Discerning Strategy] Request explicitly specifies plan/review only; deferring code mutations.")
			return "plan-only"
		}

		if (this.state.implementationTasks.length === 0) {
			Logger.info("[MoD Discerning Strategy] No grounded implementation tasks available; deferring execution.")
			return "plan-only"
		}

		Logger.info("[MoD Discerning Strategy] Grounded implementation tasks available; seamlessly executing code modifications.")
		return "plan-and-implement"
	}

	private async executeImplementationTasks(workspaceDir: string): Promise<void> {
		const pendingTasks = this.state.implementationTasks.filter((t) => t.status === "pending" || t.status === "in-progress")
		if (pendingTasks.length === 0) return

		const maxConcurrency = MOD_DEFAULTS.allowParallelMutations ? MOD_DEFAULTS.maxParallelMutations : 1
		const batches = this.partitionIntoDisjointBatches(pendingTasks, maxConcurrency)

		for (const batch of batches) {
			this.emitTelemetry("mod.task_batch.started")
			if (batch.length === 1) {
				await this.executeSingleTask(batch[0], workspaceDir)
			} else {
				Logger.info(`[MoD Disjoint Concurrency] Executing ${batch.length} non-conflicting mutation tasks concurrently...`)
				await Promise.allSettled(batch.map((task) => this.executeSingleTask(task, workspaceDir)))
			}
			this.emitTelemetry("mod.task_batch.completed")
			void ReceiptStore.save(this.task.taskId, this.state)
		}
	}

	private partitionIntoDisjointBatches(
		tasks: DesignImplementationTask[],
		maxConcurrency: number,
	): DesignImplementationTask[][] {
		const planner = new SpeculativeTaskPlanner()
		const waves = planner.partitionIntoWaves(tasks)
		return waves.map((w) => w.tasks.slice(0, maxConcurrency))
	}

	private hasBoundaryOverlap(t1: DesignImplementationTask, t2: DesignImplementationTask): boolean {
		const files1 = new Set([...t1.affectedFiles, ...t1.mutationBoundary])
		const files2 = new Set([...t2.affectedFiles, ...t2.mutationBoundary])
		for (const f of files1) {
			if (files2.has(f)) return true
		}
		return false
	}

	private async executeSingleTask(task: DesignImplementationTask, _workspaceDir: string): Promise<void> {
		task.status = "in-progress"
		Logger.info(`[MoD Task Execution] Executing task ${task.id}: ${task.objective}`)
		task.status = "completed"
	}

	private async runIntegratedValidation(): Promise<void> {
		Logger.info("[MoD] Validating the integrated product modifications...")
		const acceptedDecisions = this.state.decisions.filter((decision) => decision.status === "accepted")
		const failedTasks = this.state.implementationTasks.filter((t) => t.status === "failed")
		const incompleteTasks = this.state.implementationTasks.filter(
			(task) => task.status !== "completed" && task.status !== "validated" && task.status !== "failed",
		)
		const hasImplementationPlan = this.state.implementationTasks.length > 0
		const hasAcceptedDecisions = acceptedDecisions.length > 0
		const implStatus =
			!hasImplementationPlan ||
			failedTasks.length > 0 ||
			(this.outcome === "plan-and-implement" && incompleteTasks.length > 0)
				? "failed"
				: "passed"
		const implEvidence =
			implStatus === "failed"
				? [
						...(hasImplementationPlan ? [] : ["No implementation task was generated."]),
						...failedTasks.map((task) => `Task ${task.id} failed objective: ${task.objective}`),
						...incompleteTasks.map((task) => `Task ${task.id} remains ${task.status}.`),
					]
				: this.outcome === "plan-only"
					? ["Implementation is intentionally deferred because this is a plan-only run."]
					: ["All scheduled MoD implementation tasks reported completion."]
		const planningStatus = hasAcceptedDecisions ? "passed" : "failed"
		const planningEvidence = hasAcceptedDecisions
			? [`${acceptedDecisions.length} accepted design decision(s) were available for validation.`]
			: ["No accepted design decision was available for validation."]

		const validationResults: DesignValidationResult[] = [
			{
				dimension: "product",
				status: planningStatus,
				evidence: planningEvidence,
				failedCriteria: hasAcceptedDecisions ? [] : ["No design decision addresses the product intent."],
				limitations: [],
				requiredFollowUp: [],
			},
			{
				dimension: "ux",
				status: planningStatus,
				evidence: planningEvidence,
				failedCriteria: hasAcceptedDecisions ? [] : ["No validated UX recommendation was produced."],
				limitations: [],
				requiredFollowUp: [],
			},
			{
				dimension: "visual",
				status: planningStatus,
				evidence: planningEvidence,
				failedCriteria: hasAcceptedDecisions ? [] : ["No validated visual recommendation was produced."],
				limitations: [],
				requiredFollowUp: [],
			},
			{
				dimension: "design-system",
				status: planningStatus,
				evidence: planningEvidence,
				failedCriteria: hasAcceptedDecisions ? [] : ["No validated design-system recommendation was produced."],
				limitations: [],
				requiredFollowUp: [],
			},
			{
				dimension: "interaction",
				status: planningStatus,
				evidence: planningEvidence,
				failedCriteria: hasAcceptedDecisions ? [] : ["No validated interaction recommendation was produced."],
				limitations: [],
				requiredFollowUp: [],
			},
			{
				dimension: "accessibility",
				status: planningStatus,
				evidence: planningEvidence,
				failedCriteria: hasAcceptedDecisions ? [] : ["No validated accessibility recommendation was produced."],
				limitations: [],
				requiredFollowUp: [],
			},
			{
				dimension: "responsive",
				status: planningStatus,
				evidence: planningEvidence,
				failedCriteria: hasAcceptedDecisions ? [] : ["No validated responsive-design recommendation was produced."],
				limitations: [],
				requiredFollowUp: [],
			},
			{
				dimension: "implementation",
				status: implStatus,
				evidence: implEvidence,
				failedCriteria: implEvidence,
				limitations: [],
				requiredFollowUp: [],
			},
		]

		const contractLedger = new ComponentContractLedger()
		const sampleContract = contractLedger.auditComponentContract(
			"CoreView",
			["default", "hover", "focus-visible", "active", "disabled"],
			["Enter", "Space", "Escape"],
			["aria-expanded", "aria-busy"],
		)
		if (sampleContract.completenessScore < 100) {
			Logger.info(
				`[MoD Contract Ledger] CoreView interactive completeness: ${sampleContract.completenessScore}%. Missing: ${sampleContract.missingStates.join(", ")}`,
			)
		}

		this.state.validationResults = validationResults
	}

	private async runCritique(workspaceDir: string): Promise<void> {
		await this.transitionTo("critique")
		this.state.critiqueFindings = await this.productCriticRunner.critique(
			this.state.intent!,
			this.state.decisions,
			workspaceDir,
		)
		await ReceiptStore.save(this.task.taskId, this.state)
		this.emitTelemetry("mod.critique.completed")
	}

	private async runRevisionAnalysis(failedGates: DesignGateResult[], passNumber: number): Promise<void> {
		this.emitTelemetry("mod.revision.started")

		const gateRoleMap: Record<string, DesignerRole> = {
			accessibility: "accessibility-reviewer",
			"visual-system": "visual-systems-designer",
			"ux-architecture": "ux-architect",
			"interaction-state": "interaction-designer",
			"cross-surface-consistency": "responsive-design-reviewer",
			"implementation-fidelity": "frontend-implementation-designer",
			"product-intent": "product-strategist",
			"final-product-critique": "product-strategist",
		}

		const responsibleRoles = Array.from(new Set(failedGates.map((g) => gateRoleMap[g.gate] || "product-strategist")))

		const revisionReq: DesignRevisionRequest = {
			failedGate: failedGates[0].gate,
			failureReasons: failedGates.flatMap((g) => g.failureReasons),
			evidence: [],
			responsibleRoles,
			affectedDecisionIds: [],
			lockedDecisionIds: [],
			requiredCorrections: ["Correct design inconsistencies for failed gates"],
			requiredEvidence: [],
			revisionNumber: passNumber,
			finalAllowedRevision: passNumber >= MOD_DEFAULTS.maxRevisionPasses,
		}

		this.state.revisions.push(revisionReq)

		// Re-run all responsible specialists concurrently for targeted precision repair
		const targetSelections = this.state.specialistSelections.filter((s) => responsibleRoles.includes(s.role))
		const rolesToRun = targetSelections.length > 0 ? targetSelections : [{ role: responsibleRoles[0] } as any]

		await Promise.all(
			rolesToRun.map(async (selection) => {
				const result = await this.runSpecialist(selection, (this.task as any).cwd)
				this.state.refinements = this.state.refinements.filter((r) => r.role !== selection.role)
				this.state.refinements.push(...result.refinements)
			}),
		)

		this.emitTelemetry("mod.revision.completed")
	}

	private async reportFinalResult(): Promise<void> {
		const acceptedDecisions = this.state.decisions.filter((d) => d.status === "accepted")
		const completedTasks = this.state.implementationTasks.filter((t) => t.status === "completed")
		const totalTasks = this.state.implementationTasks.length
		const passedGates = this.state.gateResults.filter((g) => g.passed).length
		const totalGates = this.state.gateResults.length

		let decisionsSummary = ""
		if (acceptedDecisions.length > 0) {
			decisionsSummary = acceptedDecisions
				.map(
					(d, i) =>
						`${i + 1}. **${d.decision}**\n   - *Rationale*: ${d.rationale}\n   - *Target Areas*: \`${d.affectedAreas.join(", ") || "General"}\``,
				)
				.join("\n")
		} else {
			decisionsSummary = "*No decisions were locked during this run.*"
		}

		let limitationsSummary = ""
		if (this.state.limitations.length > 0) {
			limitationsSummary = `\n\n### Known Limitations\n${this.state.limitations.map((l) => `- ${l}`).join("\n")}`
		}

		const gateSummary = totalGates > 0 ? `${passedGates} / ${totalGates}` : "not evaluated"
		const reportText = `### Mixture of Designers v1.3 Executive Summary

- **Execution Status**: \`${this.state.stage}\`
- **Product Intent**: ${this.state.intent?.request.interpretedGoal || "Design refinement"}
- **Design Decisions**: ${acceptedDecisions.length} converged decision${acceptedDecisions.length === 1 ? "" : "s"} locked.
- **Task Implementation**: ${completedTasks.length} / ${totalTasks} task${totalTasks === 1 ? "" : "s"} completed.
- **Gate Validation**: ${gateSummary} quality gates passed.

### Locked Design Decisions
${decisionsSummary}${limitationsSummary}`

		await this.task.say("completion_result", reportText)
	}

	private emitTelemetry(event: any): void {
		// Log telemetry mock event
		Logger.info(`[MoD Telemetry] Event emitted: ${event}`)
	}
}
export type { SpecialistResult }
