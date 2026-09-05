// Union mantida manualmente — é o único ponto de types.ts que precisa mudar
// pra adicionar um agente novo. Ver "Adicionando um novo agente" no
// CLAUDE.md pro passo a passo completo (o resto da fiação vive em
// `agents/registry.ts`, derivada a partir dessa union).
export type AgentName = "claude" | "antigravity";

/** Interface que todo wrapper de agente implementa — ver agents/registry.ts e CLAUDE.md. */
export type AgentRunner = (options: AgentRunOptions) => Promise<AgentRunResult>;

/**
 * Estratégia de roteamento quando não há agente forçado (nem global via
 * `--agent`/`/agent`, nem por prefixo "claude:"/"antigravity:" na tarefa):
 * - "keyword" (padrão): `planTask()` por palavra-chave; `--auto`/`/auto`
 *   liga um fallback pra `classifyTaskWithClaude()` só quando a keyword não
 *   decidiu nada.
 * - "classify": pula `planTask()` inteiramente e classifica TODA tarefa via
 *   `classifyTaskWithClaude()` — mais lento (chamada extra ao claude antes
 *   de rodar de verdade) e mais robusto pra tarefas sem palavra-chave óbvia.
 *   `--auto`/`/auto` não tem efeito adicional aqui (a classificação já
 *   sempre acontece).
 */
export type RoutingStrategy = "keyword" | "classify";

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
