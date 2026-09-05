import { execa } from "execa";
import { AgentError, type AgentName, type AgentRunResult } from "../types.js";

export const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

export interface RunAgentCommandOptions {
  agent: AgentName;
  command: string;
  args: string[];
  prompt: string;
  timeoutMs?: number;
  /**
   * Chamado com cada pedaço de stdout assim que o processo escreve, antes
   * dele terminar. Só reflete streaming de verdade se o CLI subjacente
   * também escrever de forma incremental — ver `AGENT_STREAMS_INCREMENTALLY`
   * em `types.ts`. Não afeta o `output` final devolvido (continua vindo do
   * buffer completo do `execa`, igual antes).
   */
  onChunk?: (chunk: string) => void;
}

export async function runAgentCommand(
  options: RunAgentCommandOptions,
): Promise<AgentRunResult> {
  const { agent, command, args, prompt, timeoutMs = DEFAULT_TIMEOUT_MS, onChunk } = options;
  const startedAt = new Date().toISOString();
  const start = Date.now();

  let result: Awaited<ReturnType<typeof execa>>;
  try {
    const subprocess = execa(command, args, { timeout: timeoutMs, reject: false });
    if (onChunk) {
      subprocess.stdout?.on("data", (chunk: Buffer | string) => {
        onChunk(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      });
    }
    result = await subprocess;
  } catch (cause) {
    if (isEnoent(cause)) {
      throw new AgentError(
        agent,
        "command_not_found",
        `Comando "${command}" não encontrado no PATH`,
        cause,
      );
    }
    throw new AgentError(agent, "unknown", `Falha inesperada ao executar "${command}"`, cause);
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - start;

  if (result.timedOut) {
    throw new AgentError(
      agent,
      "timeout",
      `"${command}" excedeu o timeout de ${timeoutMs}ms`,
      result,
    );
  }

  const stderr = asText(result.stderr);
  const stdout = asText(result.stdout);

  if (result.failed && looksLikeAuthError(stderr)) {
    throw new AgentError(
      agent,
      "auth_expired",
      `Sessão de "${command}" parece expirada — reautentique manualmente`,
      result,
    );
  }

  if (result.exitCode !== 0) {
    throw new AgentError(
      agent,
      "nonzero_exit",
      `"${command}" saiu com código ${result.exitCode}: ${stderr}`,
      result,
    );
  }

  return {
    agent,
    prompt,
    output: stdout,
    startedAt,
    finishedAt,
    durationMs,
  };
}

function asText(value: string | Uint8Array | unknown[] | undefined): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return "";
}

function isEnoent(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function looksLikeAuthError(stderr: string): boolean {
  const lowered = stderr.toLowerCase();
  return (
    lowered.includes("not authenticated") ||
    lowered.includes("please login") ||
    lowered.includes("please log in") ||
    lowered.includes("session expired") ||
    lowered.includes("unauthorized")
  );
}
