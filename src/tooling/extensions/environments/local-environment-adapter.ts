import { spawn } from "node:child_process";
import type {
  ExecutionBackendType,
  ExecutionCommandResult,
  ExecutionCommandSpec,
  IExecutionEnvironmentAdapter,
  ISecretScrubber,
} from "../../../core/contracts/environment.contracts.js";

/**
 * Deterministic Local Execution Environment Adapter.
 *
 * Spawns child processes locally with strict timeout enforcement,
 * environment secret scrubbing, and bounded stream output capture.
 */
export class LocalEnvironmentAdapter implements IExecutionEnvironmentAdapter {
  readonly backendType: ExecutionBackendType = "local";
  private readonly secretScrubber: ISecretScrubber;

  constructor(secretScrubber: ISecretScrubber) {
    this.secretScrubber = secretScrubber;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async executeCommand(spec: ExecutionCommandSpec): Promise<ExecutionCommandResult> {
    spec.signal?.throwIfAborted();
    const startedAt = Date.now();
    const timeoutMs = spec.timeoutMs ?? 30000;
    const cwd = spec.cwd ?? process.cwd();

    // Prepare clean environment without secrets
    const baseEnv = spec.env ?? (process.env as Record<string, string>);
    const cleanEnv = this.secretScrubber.scrubEnvironment(baseEnv);

    return new Promise<ExecutionCommandResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let finished = false;
      let stopping = false;
      let forceTimer: NodeJS.Timeout | undefined;

      // Extract binary and args
      const command = spec.command + (spec.args?.length ? " " + spec.args.map(arg => "'" + arg.replace(/'/g, "'\\''") + "'").join(" ") : "");

      // Spawn process
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, {
          cwd,
          env: cleanEnv,
          shell: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return resolve({
          stdout: "",
          stderr: `Spawn error: ${errorMsg}`,
          exitCode: 1,
          durationMs: Date.now() - startedAt,
          timedOut: false,
          backendUsed: "local",
          workingDirectory: cwd,
        });
      }

      const terminate = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try { if (process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") stderr += `\nCleanup unresolved: ${String(error)}`; }
      };
      const stop = () => {
        if (finished || stopping) return;
        stopping = true;
        terminate("SIGTERM");
        forceTimer = setTimeout(() => terminate("SIGKILL"), 1000);
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer); clearTimeout(forceTimer);
        spec.signal?.removeEventListener("abort", stop);
        if (stopping) terminate("SIGKILL");
      };
      spec.signal?.addEventListener("abort", stop, { once: true });
      if (spec.signal?.aborted) stop();

      let bytes = 0;
      const consume = (chunk: string, error: boolean) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 500000) {
          if (!stopping) stderr += "\n[Output limit reached; evidence incomplete.]";
          stop(); return;
        }
        if (error) stderr += chunk; else stdout += chunk;
        try { spec.onOutput?.({ stream: error ? "stderr" : "stdout", text: chunk, elapsedMs: Date.now() - startedAt }); }
        catch { /* A progress observer must not stop the process or lose its result. */ }
      };
      child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", chunk => consume(chunk, false));
      child.stderr?.on("data", chunk => consume(chunk, true));

      child.on("error", (err) => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve({
          stdout,
          stderr: `${stderr}\nProcess error: ${err.message}`.trim(),
          exitCode: 1,
          durationMs: Date.now() - startedAt,
          timedOut,
          backendUsed: "local",
          workingDirectory: cwd,
        });
      });

      child.on("close", (exitCode) => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve({
          stdout,
          stderr,
          exitCode: timedOut ? 124 : stopping ? (exitCode || 130) : exitCode ?? 1,
          durationMs: Date.now() - startedAt,
          timedOut,
          backendUsed: "local",
          workingDirectory: cwd,
        });
      });
    });
  }
}
