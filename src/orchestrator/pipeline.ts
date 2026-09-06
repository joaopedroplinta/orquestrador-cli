import { AGENT_REGISTRY } from "../agents/registry.js";
import { finishRun, logStep, startRun } from "../storage/history.js";
import {
  AgentError,
  PipelineCancelledError,
  type AgentName,
  type AgentRetryAttempt,
  type AgentRunResult,
  type RoutingStrategy,
} from "../types.js";
import { classifyTaskWithClaude, parseTaskAgentPrefix, planTask, type TaskStep } from "./router.js";

const SIMULATED_REVEAL_STEPS = 24;
const SIMULATED_REVEAL_DURATION_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fallback visual pra agentes que não escrevem stdout de forma incremental
// (ver `streamsIncrementally` em agents/registry.ts) — o texto já chegou completo
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
  /**
   * Estratégia de roteamento quando não há `forceAgent` (nem global nem por
   * prefixo) — padrão "keyword". Ver `RoutingStrategy` em types.ts.
   */
  routing?: RoutingStrategy;
  /** Tarefa ambígua com routing="keyword": tenta classificar via claude antes de cair pro fallback interativo. Sem efeito com routing="classify" (a classificação já sempre acontece). */
  auto?: boolean;
  /** Chamado quando a tarefa é ambígua e `auto` não resolveu. Retorna `null` pra cancelar. */
  resolveAmbiguousAgent?: (task: string) => Promise<AgentName | null>;
  /** Chamado antes de cada etapa do plano começar a rodar. */
  onStepStart?: (agent: AgentName) => void;
  /**
   * Chamado com cada pedaço de output da etapa em andamento. Real (conforme o
   * processo escreve) se o agente suportar (`streamsIncrementally` em
   * agents/registry.ts); senão, é o fallback simulado de
   * `simulateStreamingReveal` — o código que
   * dispara cada caso está claramente separado, mas quem consome `onChunk`
   * recebe o mesmo formato dos dois jeitos.
   */
  onChunk?: (agent: AgentName, chunk: string) => void;
  /** Chamado assim que uma etapa termina com sucesso, antes das próximas rodarem. */
  onStepComplete?: (result: AgentRunResult) => void;
  /** Máximo de tentativas de RETRY por etapa em erro transitório (não conta a tentativa inicial) — padrão 3. */
  maxRetries?: number;
  /** Base do backoff exponencial em ms — padrão 1000, ver DEFAULT_RETRY_BASE_DELAY_MS em agents/shared.ts. */
  retryBaseDelayMs?: number;
  /** Chamado antes de cada espera de backoff entre tentativas de uma etapa — pra não parecer que travou. */
  onRetry?: (agent: AgentName, info: AgentRetryAttempt & { maxRetries: number }) => void;
}

export interface PipelineResult {
  runId: string;
  task: string;
  steps: AgentRunResult[];
}

export async function runPipeline(options: RunPipelineOptions): Promise<PipelineResult> {
  // "claude: implementar X" força o agente só dessa tarefa, sem precisar de
  // --agent/--auto pro lote inteiro (ver parseTaskAgentPrefix em router.ts).
  // Prioridade: --agent global (options.forceAgent) > prefixo por tarefa >
  // roteamento automático (planTask/--auto/resolver de ambiguidade).
  const prefix = parseTaskAgentPrefix(options.task);
  if (prefix.invalidAgentName) {
    throw new Error(
      `Prefixo de agente inválido: "${prefix.invalidAgentName}:" em "${options.task}". Use "claude:", "antigravity:" ou "codex:" (ou nenhum prefixo).`,
    );
  }

  const task = prefix.text;
  if (!task.trim()) throw new Error("A tarefa não pode estar vazia.");
  const forceAgent = options.forceAgent ?? prefix.agent;
  const routing = options.routing ?? "keyword";

  let plan: TaskStep[];
  if (forceAgent) {
    plan = [{ agent: forceAgent, prompt: task }];
  } else if (prefix.agents) {
    plan = prefix.agents.map((agent, index, agents) => ({
      agent,
      prompt: [
        `Tarefa do usuário: ${task}`,
        `Você é ${agent}, etapa ${index + 1}/${agents.length} da colaboração: ${agents.join(" → ")}.`,
        "Execute a parte da tarefa correspondente à sua posição e às instruções do usuário.",
        "Use o resultado anterior como contexto; confira o trabalho existente antes de alterar arquivos.",
        "Ao terminar, informe o que fez, verificações e pendências para o próximo agente.",
      ].join("\n\n"),
    }));
  } else if (routing === "classify") {
    // Pula planTask() inteiramente — toda tarefa passa pela IA, não só a
    // que a keyword deixou ambígua. --auto não entra em jogo aqui: a
    // classificação já é sempre a primeira (e única) tentativa.
    plan = (await classifyTaskWithClaude(task)) ?? [];
  } else {
    plan = planTask(task);
    if (plan.length === 0 && options.auto) {
      plan = (await classifyTaskWithClaude(task)) ?? [];
    }
  }

  if (plan.length === 0) {
    if (!options.resolveAmbiguousAgent) {
      throw new Error(
        `Não foi possível decidir qual agente usar pra: "${task}". Especifique com --agent claude|antigravity|codex.`,
      );
    }

    const chosen = await options.resolveAmbiguousAgent(task);
    if (!chosen) {
      throw new PipelineCancelledError(task);
    }
    plan = [{ agent: chosen, prompt: task }];
  }

  const runId = startRun(task);
  const steps: AgentRunResult[] = [];
  let previousOutput: string | undefined;
  let previousStepId: number | undefined;

  try {
    for (const taskStep of plan) {
      options.onStepStart?.(taskStep.agent);

      const agentDef = AGENT_REGISTRY[taskStep.agent];
      const streamsIncrementally = agentDef.streamsIncrementally;
      const result = await agentDef.runner({
        prompt: taskStep.prompt,
        context: previousOutput,
        // Só passa onChunk pro wrapper quando o agente escreve de forma
        // incremental de verdade — pra um agente que não escreve (claude),
        // isso resultaria num único chunk gigante bem no final, então nem
        // vale a pena: simulamos a revelação progressiva logo abaixo em vez
        // de fingir que aquele chunk único é "streaming".
        onChunk: streamsIncrementally && options.onChunk ? (chunk) => options.onChunk!(taskStep.agent, chunk) : undefined,
        maxRetries: options.maxRetries,
        retryBaseDelayMs: options.retryBaseDelayMs,
        onRetry: options.onRetry ? (info) => options.onRetry!(taskStep.agent, info) : undefined,
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
        retries: result.retries,
        usage: result.usage,
      });
      previousOutput = result.output;
    }
  } catch (error) {
    if (error instanceof AgentError) {
      const timestamp = new Date().toISOString();
      logStep(runId, {
        agent: error.agent,
        prompt: task,
        output: "",
        startedAt: timestamp,
        finishedAt: timestamp,
        durationMs: 0,
        error: `${error.kind}: ${error.message}`,
        fedByStepId: previousStepId,
        retries: error.retries.length > 0 ? error.retries : undefined,
      });
    }
    finishRun(runId);
    throw error;
  }

  finishRun(runId);
  return { runId, task, steps };
}

export interface RunManyOptions {
  tasks: string[];
  forceAgent?: AgentName;
  routing?: RoutingStrategy;
  auto?: boolean;
  /** Mesmos callbacks de streaming do runPipeline, mas com o índice (em `tasks`) da tarefa dona do evento. */
  onTaskStepStart?: (taskIndex: number, agent: AgentName) => void;
  onTaskChunk?: (taskIndex: number, agent: AgentName, chunk: string) => void;
  onTaskStepComplete?: (taskIndex: number, result: AgentRunResult) => void;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  onTaskRetry?: (taskIndex: number, agent: AgentName, info: AgentRetryAttempt & { maxRetries: number }) => void;
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
    options.tasks.map((task, index) =>
      runPipeline({
        task,
        forceAgent: options.forceAgent,
        routing: options.routing,
        auto: options.auto,
        maxRetries: options.maxRetries,
        retryBaseDelayMs: options.retryBaseDelayMs,
        onStepStart: options.onTaskStepStart ? (agent) => options.onTaskStepStart!(index, agent) : undefined,
        onChunk: options.onTaskChunk ? (agent, chunk) => options.onTaskChunk!(index, agent, chunk) : undefined,
        onStepComplete: options.onTaskStepComplete ? (result) => options.onTaskStepComplete!(index, result) : undefined,
        onRetry: options.onTaskRetry ? (agent, info) => options.onTaskRetry!(index, agent, info) : undefined,
      }),
    ),
  );

  return settled.map((outcome, i) => {
    const task = options.tasks[i]!;
    return outcome.status === "fulfilled" ? { task, result: outcome.value } : { task, error: outcome.reason };
  });
}
