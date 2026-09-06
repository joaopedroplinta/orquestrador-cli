import { runAgentCommand } from "./shared.js";
import { AgentError, type AgentRunOptions, type AgentRunResult, type AgentUsage } from "../types.js";

/** Usa a autenticação do Codex instalado e mantém as edições no sandbox do workspace. */
export async function runCodex(options: AgentRunOptions): Promise<AgentRunResult> {
  const prompt = options.context ? `${options.context}\n\n${options.prompt}` : options.prompt;
  const result = await runAgentCommand({
    agent: "codex",
    command: "codex",
    args: ["exec", "--json", "--sandbox", "workspace-write", "-"],
    input: prompt,
    prompt,
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    retryBaseDelayMs: options.retryBaseDelayMs,
    onRetry: options.onRetry,
  });
  // Não envia JSON, comandos executados ou raciocínio interno para a UI/handoff.
  return parseCodexEvents(result);
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseCodexEvents(result: AgentRunResult): AgentRunResult {
  let output: string | undefined;
  let completed = false;
  let usage: AgentUsage | undefined;
  const fail = (message: string): never => {
    throw new AgentError("codex", "nonzero_exit", message, undefined, result.retries);
  };

  for (const line of result.output.split(/\r?\n/).filter((line) => line.trim())) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      fail("Codex retornou uma linha JSONL inválida.");
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      fail("Codex retornou um evento sem tipo válido.");
    }
    if (event.type === "turn.failed") {
      fail(`Codex falhou: ${event.error?.message ?? "turno não concluído"}`);
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      output = event.item.text;
    }
    if (event.type === "turn.completed") {
      completed = true;
      if (event.usage && typeof event.usage === "object") {
        usage = {
          inputTokens: tokenCount(event.usage.input_tokens),
          outputTokens: tokenCount(event.usage.output_tokens),
          cacheReadTokens: tokenCount(event.usage.cached_input_tokens),
          thinkingTokens: tokenCount(event.usage.reasoning_output_tokens),
        };
      }
    }
  }
  if (!completed || output === undefined || !output.trim()) {
    fail("Codex terminou sem um turno concluído e uma resposta final. Verifique a autenticação e a versão do CLI.");
  }
  return { ...result, output: output!, usage };
}
