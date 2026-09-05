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
}

export interface AgentRunResult {
  agent: AgentName;
  prompt: string;
  output: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export type AgentErrorKind =
  | "timeout"
  | "command_not_found"
  | "auth_expired"
  | "nonzero_exit"
  | "unknown";

export class AgentError extends Error {
  constructor(
    public readonly agent: AgentName,
    public readonly kind: AgentErrorKind,
    message: string,
    public readonly cause?: unknown,
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
}

export interface HistoryRun {
  id: string;
  task: string;
  startedAt: string;
  finishedAt?: string;
  steps: HistoryStep[];
}
