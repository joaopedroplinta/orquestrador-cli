import { execa } from "execa";
import {
  AgentError,
  RETRYABLE_AGENT_ERROR_KINDS,
  type AgentName,
  type AgentRetryAttempt,
  type AgentRunResult,
} from "../types.js";

export const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;
export const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

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
  /** Máximo de tentativas de RETRY (não conta a tentativa inicial) — padrão 3. */
  maxRetries?: number;
  /** Chamado antes de cada espera de backoff, com detalhes da tentativa que acabou de falhar. */
  onRetry?: (info: AgentRetryAttempt & { maxRetries: number }) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Loop de retry com backoff exponencial simples (1s, 2s, 4s, ...) em torno de
// uma única tentativa (`attemptOnce`). Só repete erros classificados como
// transitórios (`RETRYABLE_AGENT_ERROR_KINDS` em types.ts) — comando não
// encontrado ou argumento inválido, por exemplo, falham direto na primeira
// tentativa, sem sentido repetir algo que vai dar o mesmo erro de novo.
export async function runAgentCommand(options: RunAgentCommandOptions): Promise<AgentRunResult> {
  const { maxRetries = DEFAULT_MAX_RETRIES, onRetry, ...attemptOptions } = options;
  const retries: AgentRetryAttempt[] = [];

  for (let attempt = 1; ; attempt++) {
    try {
      const result = await attemptOnce(attemptOptions);
      return retries.length > 0 ? { ...result, retries } : result;
    } catch (error) {
      const canRetry =
        error instanceof AgentError && RETRYABLE_AGENT_ERROR_KINDS.has(error.kind) && attempt <= maxRetries;

      if (!canRetry) {
        // Propaga o erro final já com o histórico de tentativas anteriores
        // embutido, pra quem chamou (pipeline.ts) conseguir logar tudo no
        // histórico, não só a última falha.
        if (error instanceof AgentError && retries.length > 0) {
          throw new AgentError(error.agent, error.kind, error.message, error.cause, retries);
        }
        throw error;
      }

      const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      const attemptInfo: AgentRetryAttempt = {
        attempt,
        kind: error.kind,
        message: error.message,
        delayMs,
        timestamp: new Date().toISOString(),
      };
      retries.push(attemptInfo);
      onRetry?.({ ...attemptInfo, maxRetries });
      await sleep(delayMs);
    }
  }
}

type AttemptOnceOptions = Omit<RunAgentCommandOptions, "maxRetries" | "onRetry">;

async function attemptOnce(options: AttemptOnceOptions): Promise<AgentRunResult> {
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
    if (looksLikeInvalidArgumentError(stderr)) {
      throw new AgentError(
        agent,
        "invalid_argument",
        `"${command}" recebeu um argumento inválido: ${stderr}`,
        result,
      );
    }
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

// Heurística pra distinguir "exit code não-zero que pareça momentâneo" (vale
// a pena repetir) de erro de sintaxe/argumento inválido (vai falhar do mesmo
// jeito numa segunda tentativa idêntica, então não é elegível pra retry).
function looksLikeInvalidArgumentError(stderr: string): boolean {
  const lowered = stderr.toLowerCase();
  return (
    lowered.includes("unknown option") ||
    lowered.includes("unknown flag") ||
    lowered.includes("unrecognized argument") ||
    lowered.includes("unrecognized option") ||
    lowered.includes("invalid option") ||
    lowered.includes("invalid argument") ||
    lowered.includes("missing required argument") ||
    lowered.includes("usage:")
  );
}
