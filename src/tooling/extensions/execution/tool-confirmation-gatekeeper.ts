/**
 * tool-confirmation-gatekeeper.ts
 *
 * Interactive & Programmable Tool Confirmation Gatekeeper.
 * Intercepts tools marked with `requiresConfirmation: true` or evaluated as `CRITICAL`
 * by ToolSafetyPolicyManager. Supports interactive decisions (allow, deny, allow_all_session),
 * autonomous execution authority elevation, zero-deadlock bypass modes, and feeds
 * model-facing rejection reasons back into the reasoning loop.
 */

import type { ExecutionAuthorityLevel } from "../../../core/contracts/tooling.contracts.js";
import type { ToolRiskTier, ToolSafetyAssessment } from "./tool-safety-policy-manager.js";

export type ConfirmationDecision = "allow" | "allow_all_session" | "deny";

export class ToolApprovalDeniedError extends Error {
  constructor(message: string) { super(message); this.name = "ToolApprovalDeniedError"; }
}

export interface ConfirmationRequest {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly safetyAssessment: ToolSafetyAssessment;
  readonly promptMessage: string;
}

export interface ConfirmationResponse {
  readonly decision: ConfirmationDecision;
  readonly feedback?: string;
}

export type ConfirmationHook = (
  request: ConfirmationRequest
) => Promise<ConfirmationResponse> | ConfirmationResponse;

export interface AutoApprovePolicy {
  executionAuthority: ExecutionAuthorityLevel;
  bypassConfirmation: boolean;
  bypassThreatDeadlocks: boolean;
  autoApproveRiskTiers: readonly ToolRiskTier[];
  allowedToolPatterns?: readonly (string | RegExp)[];
}

export interface ConfirmationCheckResult {
  readonly approved: boolean;
  readonly feedback?: string;
  readonly rejectionFeedback?: string;
  readonly autoApproved?: boolean;
  readonly authorityLevel?: ExecutionAuthorityLevel;
}


export class ToolConfirmationGatekeeper {
  private allowedSessionTools = new Set<string>();
  private confirmationHook?: ConfirmationHook;
  private requiredHostHook?: ConfirmationHook;

  public setRequiredHostHook(hook: ConfirmationHook): void {
    this.requiredHostHook = hook;
  }
  private currentAuthority: ExecutionAuthorityLevel = "autonomous";
  private autoApprovePolicy: AutoApprovePolicy = {
    executionAuthority: "autonomous",
    bypassConfirmation: false,
    bypassThreatDeadlocks: true,
    autoApproveRiskTiers: ["SAFE", "MUTATING", "CRITICAL"],
  };

  constructor(options: {
    confirmationHook?: ConfirmationHook;
    authority?: ExecutionAuthorityLevel;
    autoApprovePolicy?: Partial<AutoApprovePolicy>;
  } = {}) {
    this.confirmationHook = options.confirmationHook;
    if (options.authority) {
      this.currentAuthority = options.authority;
      this.autoApprovePolicy.executionAuthority = options.authority;
    }
    if (options.autoApprovePolicy) {
      this.autoApprovePolicy = { ...this.autoApprovePolicy, ...options.autoApprovePolicy };
    }
  }

  /**
   * Sets or updates the confirmation hook.
   */
  public setConfirmationHook(hook?: ConfirmationHook): void {
    this.confirmationHook = hook;
  }

  /**
   * Sets active execution authority level.
   */
  public setExecutionAuthority(authority: ExecutionAuthorityLevel): void {
    this.currentAuthority = authority;
    this.autoApprovePolicy.executionAuthority = authority;
  }

  /**
   * Returns current active execution authority.
   */
  public getExecutionAuthority(): ExecutionAuthorityLevel {
    return this.currentAuthority;
  }

  /**
   * Sets or updates auto-approval policy.
   */
  public setAutoApprovePolicy(policy: Partial<AutoApprovePolicy>): void {
    this.autoApprovePolicy = { ...this.autoApprovePolicy, ...policy };
    if (policy.executionAuthority) {
      this.currentAuthority = policy.executionAuthority;
    }
  }

  /**
   * Returns current auto-approval policy.
   */
  public getAutoApprovePolicy(): AutoApprovePolicy {
    return { ...this.autoApprovePolicy };
  }

  /**
   * Enables autonomous execution authority (zero confirmation blocking).
   */
  public enableAutonomousMode(): void {
    this.setExecutionAuthority("autonomous");
    this.setAutoApprovePolicy({
      executionAuthority: "autonomous",
      bypassConfirmation: true,
      bypassThreatDeadlocks: true,
      autoApproveRiskTiers: ["SAFE", "MUTATING", "CRITICAL"],
    });
  }

  /**
   * Enables high-throughput execution mode.
   */
  public enableHighThroughputMode(): void {
    this.setExecutionAuthority("high_throughput");
    this.setAutoApprovePolicy({
      executionAuthority: "high_throughput",
      bypassConfirmation: true,
      bypassThreatDeadlocks: true,
      autoApproveRiskTiers: ["SAFE", "MUTATING", "CRITICAL"],
    });
  }

  /**
   * Executes a block within temporary elevated execution authority.
   */
  public async withTemporaryAuthority<T>(
    authority: ExecutionAuthorityLevel,
    fn: () => Promise<T>
  ): Promise<T> {
    const prevAuthority = this.currentAuthority;
    const prevPolicy = { ...this.autoApprovePolicy };
    try {
      this.setExecutionAuthority(authority);
      return await fn();
    } finally {
      this.currentAuthority = prevAuthority;
      this.autoApprovePolicy = prevPolicy;
    }
  }

  /**
   * Checks if an execution requires confirmation and resolves the decision.
   */
  public async checkConfirmation(
    toolName: string,
    args: Record<string, unknown>,
    safety: ToolSafetyAssessment,
    options?: { bypassConfirmation?: boolean; authority?: ExecutionAuthorityLevel }
  ): Promise<ConfirmationCheckResult> {
    if (!safety.requiresConfirmation) {
      return { approved: true };
    }

    if (!this.requiredHostHook && this.allowedSessionTools.has(toolName)) {
      return { approved: true };
    }

    const effectiveAuthority = options?.authority ?? this.currentAuthority;

    // 1. Check explicit bypass options
    if (!this.requiredHostHook && (options?.bypassConfirmation || this.autoApprovePolicy.bypassConfirmation)) {
      return {
        approved: true,
        autoApproved: true,
        authorityLevel: effectiveAuthority,
      };
    }

    // 2. If an interactive confirmation hook is attached, delegate to it
    const hook = this.requiredHostHook ?? this.confirmationHook;
    if (hook) {
      const promptMessage = `Tool '${toolName}' requires confirmation (Risk: ${safety.riskTier}, Score: ${safety.riskScore}/100).\n${safety.warnings.join("\n")}`;
      const request: ConfirmationRequest = {
        toolName,
        args,
        safetyAssessment: safety,
        promptMessage,
      };

      try {
        const response = await hook(request);
        if (response.decision === "allow") {
          return {
            approved: true,
            feedback: response.feedback,
            authorityLevel: effectiveAuthority,
          };
        }
        if (response.decision === "allow_all_session") {
          this.allowedSessionTools.add(toolName);
          return {
            approved: true,
            feedback: response.feedback,
            authorityLevel: effectiveAuthority,
          };
        }
        return {
          approved: false,
          rejectionFeedback: response.feedback || `User rejected execution of tool '${toolName}'.`,
          authorityLevel: effectiveAuthority,
        };
      } catch (err) {
        return {
          approved: false,
          rejectionFeedback: `Confirmation hook error: ${err instanceof Error ? err.message : String(err)}`,
          authorityLevel: effectiveAuthority,
        };
      }
    }

    // 3. If NO interactive hook is attached (headless automated agent loop):
    // In autonomous / high_throughput mode, auto-approve to prevent deadlocks!
    if (effectiveAuthority === "autonomous" || effectiveAuthority === "high_throughput") {
      return {
        approved: true,
        autoApproved: true,
        authorityLevel: effectiveAuthority,
      };
    }

    // 4. Check auto-approved risk tiers
    if (this.autoApprovePolicy.autoApproveRiskTiers.includes(safety.riskTier)) {
      return {
        approved: true,
        autoApproved: true,
        authorityLevel: effectiveAuthority,
      };
    }

    // 5. Check allowed tool patterns
    if (this.autoApprovePolicy.allowedToolPatterns) {
      for (const pattern of this.autoApprovePolicy.allowedToolPatterns) {
        if (typeof pattern === "string" && (toolName === pattern || toolName.includes(pattern))) {
          return { approved: true, autoApproved: true, authorityLevel: effectiveAuthority };
        }
        if (pattern instanceof RegExp && pattern.test(toolName)) {
          return { approved: true, autoApproved: true, authorityLevel: effectiveAuthority };
        }
      }
    }

    return {
      approved: false,
      rejectionFeedback: `Execution of tool '${toolName}' requires user confirmation, but no confirmation handler is active in '${effectiveAuthority}' authority mode.`,
      authorityLevel: effectiveAuthority,
    };
  }


  /**
   * Clears session approved tools.
   */
  public resetSessionApprovals(): void {
    this.allowedSessionTools.clear();
  }
}
