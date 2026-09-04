export type AgentName = "claude" | "antigravity";

export interface AgentRunOptions {
  prompt: string;
  context?: string;
  timeoutMs?: number;
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
