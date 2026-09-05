import { runAntigravity } from "../agents/antigravity.js";
import { runClaudeCode } from "../agents/claudeCode.js";
import { finishRun, logStep, startRun } from "../storage/history.js";
import {
  AGENT_STREAMS_INCREMENTALLY,
  AgentError,
  PipelineCancelledError,
  type AgentName,
  type AgentRunOptions,
  type AgentRunResult,
} from "../types.js";
import { classifyTaskWithClaude, planTask, type TaskStep } from "./router.js";

const SIMULATED_REVEAL_STEPS = 24;
const SIMULATED_REVEAL_DURATION_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fallback visual pra agentes que não escrevem stdout de forma incremental
// (ver AGENT_STREAMS_INCREMENTALLY em types.ts) — o texto já chegou completo
// do processo; isso só revela ele aos poucos, num tempo fixo, curto, pra dar
// a mesma sensação de streaming. NÃO é streaming de verdade: todo o dado já
// existe antes da primeira chamada de onChunk aqui.
async function simulateStreamingReveal(text: string, onChunk: (chunk: string) => void): Promise<void> {
  if (text.length === 0) return;

  const chunkSize = Math.max(1, Math.ceil(text.length / SIMULATED_REVEAL_STEPS));
  const steps = Math.ceil(text.length / chunkSize);
  const delayMs = SIMULATED_REVEAL_DURATION_MS / steps;

  for (let i = 0; i < text.length; i += chunkSize) {
    onChunk(text.slice(i, i + chunkSize));
    await sleep(delayMs);
  }
}

export interface RunPipelineOptions {
  task: string;
  forceAgent?: AgentName;
  /** Tarefa ambígua: tenta classificar via claude antes de cair pro fallback interativo. */
  auto?: boolean;
  /** Chamado quando a tarefa é ambígua e `auto` não resolveu. Retorna `null` pra cancelar. */
  resolveAmbiguousAgent?: (task: string) => Promise<AgentName | null>;
  /** Chamado antes de cada etapa do plano começar a rodar. */
  onStepStart?: (agent: AgentName) => void;
  /**
   * Chamado com cada pedaço de output da etapa em andamento. Real (conforme o
   * processo escreve) se o agente suportar (`AGENT_STREAMS_INCREMENTALLY`);
   * senão, é o fallback simulado de `simulateStreamingReveal` — o código que
   * dispara cada caso está claramente separado, mas quem consome `onChunk`
   * recebe o mesmo formato dos dois jeitos.
   */
  onChunk?: (agent: AgentName, chunk: string) => void;
  /** Chamado assim que uma etapa termina com sucesso, antes das próximas rodarem. */
  onStepComplete?: (result: AgentRunResult) => void;
}

export interface PipelineResult {
  runId: string;
  task: string;
  steps: AgentRunResult[];
}

const RUNNERS: Record<AgentName, (options: AgentRunOptions) => Promise<AgentRunResult>> = {
  claude: runClaudeCode,
  antigravity: runAntigravity,
};

export async function runPipeline(options: RunPipelineOptions): Promise<PipelineResult> {
  let plan: TaskStep[] = options.forceAgent
    ? [{ agent: options.forceAgent, prompt: options.task }]
    : planTask(options.task);

  if (plan.length === 0 && options.auto) {
    plan = (await classifyTaskWithClaude(options.task)) ?? [];
  }

  if (plan.length === 0) {
    if (!options.resolveAmbiguousAgent) {
      throw new Error(
        `Não foi possível decidir qual agente usar pra: "${options.task}". Especifique com --agent claude|antigravity.`,
      );
    }

    const chosen = await options.resolveAmbiguousAgent(options.task);
    if (!chosen) {
      throw new PipelineCancelledError(options.task);
    }
    plan = [{ agent: chosen, prompt: options.task }];
  }

  const runId = startRun(options.task);
  const steps: AgentRunResult[] = [];
  let previousOutput: string | undefined;
  let previousStepId: number | undefined;

  try {
    for (const taskStep of plan) {
      options.onStepStart?.(taskStep.agent);

      const streamsIncrementally = AGENT_STREAMS_INCREMENTALLY[taskStep.agent];
      const result = await RUNNERS[taskStep.agent]({
        prompt: taskStep.prompt,
        context: previousOutput,
        // Só passa onChunk pro wrapper quando o agente escreve de forma
        // incremental de verdade — pra um agente que não escreve (claude),
        // isso resultaria num único chunk gigante bem no final, então nem
        // vale a pena: simulamos a revelação progressiva logo abaixo em vez
        // de fingir que aquele chunk único é "streaming".
        onChunk: streamsIncrementally && options.onChunk ? (chunk) => options.onChunk!(taskStep.agent, chunk) : undefined,
      });

      if (!streamsIncrementally && options.onChunk) {
        await simulateStreamingReveal(result.output, (chunk) => options.onChunk!(taskStep.agent, chunk));
      }

      steps.push(result);
      options.onStepComplete?.(result);

      previousStepId = logStep(runId, {
        agent: result.agent,
        prompt: result.prompt,
        output: result.output,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        durationMs: result.durationMs,
        fedByStepId: previousStepId,
      });
      previousOutput = result.output;
    }
  } catch (error) {
    if (error instanceof AgentError) {
      const timestamp = new Date().toISOString();
      logStep(runId, {
        agent: error.agent,
        prompt: options.task,
        output: "",
        startedAt: timestamp,
        finishedAt: timestamp,
        durationMs: 0,
        error: `${error.kind}: ${error.message}`,
        fedByStepId: previousStepId,
      });
    }
    finishRun(runId);
    throw error;
  }

  finishRun(runId);
  return { runId, task: options.task, steps };
}

export interface RunManyOptions {
  tasks: string[];
  forceAgent?: AgentName;
  auto?: boolean;
}

export interface RunManyResult {
  task: string;
  result?: PipelineResult;
  error?: unknown;
}

// Tarefas top-level não têm handoff entre si, então rodam concorrentemente;
// cada uma resolve seu próprio plano e loga seu próprio run/steps normalmente.
// Sem resolveAmbiguousAgent aqui: várias tarefas não podem disputar o mesmo prompt interativo.
export async function runPipelines(options: RunManyOptions): Promise<RunManyResult[]> {
  const settled = await Promise.allSettled(
    options.tasks.map((task) => runPipeline({ task, forceAgent: options.forceAgent, auto: options.auto })),
  );

  return settled.map((outcome, i) => {
    const task = options.tasks[i]!;
    return outcome.status === "fulfilled" ? { task, result: outcome.value } : { task, error: outcome.reason };
  });
}
