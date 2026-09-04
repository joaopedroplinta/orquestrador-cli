import { runAntigravity } from "../agents/antigravity.js";
import { runClaudeCode } from "../agents/claudeCode.js";
import { finishRun, logStep, startRun } from "../storage/history.js";
import {
  AgentError,
  PipelineCancelledError,
  type AgentName,
  type AgentRunOptions,
  type AgentRunResult,
} from "../types.js";
import { classifyTaskWithClaude, planTask, type TaskStep } from "./router.js";

export interface RunPipelineOptions {
  task: string;
  forceAgent?: AgentName;
  /** Tarefa ambígua: tenta classificar via claude antes de cair pro fallback interativo. */
  auto?: boolean;
  /** Chamado quando a tarefa é ambígua e `auto` não resolveu. Retorna `null` pra cancelar. */
  resolveAmbiguousAgent?: (task: string) => Promise<AgentName | null>;
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
      const result = await RUNNERS[taskStep.agent]({
        prompt: taskStep.prompt,
        context: previousOutput,
      });
      steps.push(result);

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
