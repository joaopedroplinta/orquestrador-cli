export type AgentName = "claude" | "antigravity";

// Confirmado via probe manual (spawn + log de timing dos chunks de stdout,
// ver CLAUDE.md): "agy -p" escreve o stdout aos poucos conforme gera a
// resposta (~5-9 chunks pra uma resposta longa, ao longo de 1-2s) — dá pra
// repassar isso como streaming real. "claude -p" entrega tudo num chunk só,
// bem no final, já com o texto inteiro pronto — não há nada incremental pra
// repassar. Pra esse último, o pipeline simula a revelação progressiva no
// lado do cliente (ver `simulateStreamingReveal` em `orchestrator/pipeline.ts`),
// deixando claro que não é streaming de verdade.
export const AGENT_STREAMS_INCREMENTALLY: Record<AgentName, boolean> = {
  antigravity: true,
  claude: false,
};

export interface AgentRunOptions {
  prompt: string;
  context?: string;
  timeoutMs?: number;
  /** Chamado com cada pedaço de stdout assim que o processo escreve. */
  onChunk?: (chunk: string) => void;
  /** Máximo de tentativas de RETRY (não conta a tentativa inicial) em erro transitório — padrão 3, ver runAgentCommand em agents/shared.ts. */
  maxRetries?: number;
  /** Chamado antes de cada espera de backoff, com detalhes da tentativa que acabou de falhar. */
  onRetry?: (info: AgentRetryAttempt & { maxRetries: number }) => void;
}

export interface AgentRunResult {
  agent: AgentName;
  prompt: string;
  output: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Tentativas que falharam antes desta ter sucesso — ausente/vazio quando não precisou de retry. */
  retries?: AgentRetryAttempt[];
}

export type AgentErrorKind =
  | "timeout"
  | "command_not_found"
  | "invalid_argument"
  | "auth_expired"
  | "nonzero_exit"
  | "unknown";

// Erros elegíveis pra retry automático (ver runAgentCommand em agents/shared.ts):
// só os que podem ser um solavanco momentâneo (rede lenta, processo travando
// por um instante, sessão que expirou no meio de uma chamada longa e volta a
// funcionar na tentativa seguinte). NÃO inclui erros que vão falhar do mesmo
// jeito numa repetição idêntica — comando não encontrado no PATH ou
// argumento/sintaxe inválido não tem por que ser diferente da segunda vez.
export const RETRYABLE_AGENT_ERROR_KINDS: ReadonlySet<AgentErrorKind> = new Set([
  "timeout",
  "auth_expired",
  "nonzero_exit",
  "unknown",
]);

export interface AgentRetryAttempt {
  /** Número da tentativa que falhou (1 = tentativa inicial). */
  attempt: number;
  kind: AgentErrorKind;
  message: string;
  /** Backoff esperado antes da PRÓXIMA tentativa. */
  delayMs: number;
  timestamp: string;
}

export class AgentError extends Error {
  constructor(
    public readonly agent: AgentName,
    public readonly kind: AgentErrorKind,
    message: string,
    public readonly cause?: unknown,
    public readonly retries: AgentRetryAttempt[] = [],
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export class PipelineCancelledError extends Error {
  constructor(task: string) {
    super(`Execução cancelada: nenhum agente escolhido pra "${task}".`);
    this.name = "PipelineCancelledError";
  }
}

export interface HistoryStep {
  id?: number;
  runId: string;
  agent: AgentName;
  prompt: string;
  output: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  error?: string;
  /** id do HistoryStep cujo output foi usado como contexto de entrada desta etapa. */
  fedByStepId?: number;
  /** Tentativas que falharam antes do resultado final desta etapa (sucesso ou erro definitivo) — ausente/vazio quando não precisou de retry. */
  retries?: AgentRetryAttempt[];
}

export interface HistoryRun {
  id: string;
  task: string;
  startedAt: string;
  finishedAt?: string;
  steps: HistoryStep[];
}
