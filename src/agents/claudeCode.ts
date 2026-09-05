import { runAgentCommand } from "./shared.js";
import type { AgentRunOptions, AgentRunResult } from "../types.js";

// `claude -p` nunca escreve stdout de forma incremental (ver
// AGENT_REGISTRY.claude.streamsIncrementally em agents/registry.ts), então
// `--output-format json` não custa streaming nenhum aqui — diferente do
// antigravity, ver antigravity.ts. Confirmado via probe manual (CLAUDE.md)
// que o envelope JSON traz o texto de resposta em `.result` e uso de
// tokens/custo REAL em USD (não estimado) em `.usage`/`.total_cost_usd`.
export async function runClaudeCode(options: AgentRunOptions): Promise<AgentRunResult> {
  const prompt = options.context ? `${options.context}\n\n${options.prompt}` : options.prompt;

  const result = await runAgentCommand({
    agent: "claude",
    command: "claude",
    args: ["-p", prompt, "--output-format", "json"],
    prompt,
    timeoutMs: options.timeoutMs,
    onChunk: options.onChunk,
    maxRetries: options.maxRetries,
    onRetry: options.onRetry,
  });

  return parseClaudeJsonEnvelope(result);
}

interface ClaudeJsonEnvelope {
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens_details?: { thinking_tokens?: number };
  };
}

// Se o parsing falhar por qualquer motivo (o CLI mudou de formato, por
// exemplo), cai pro texto bruto sem usage em vez de quebrar a etapa
// inteira — usage é sempre um extra, nunca algo de que o resto do
// pipeline dependa pra funcionar.
function parseClaudeJsonEnvelope(result: AgentRunResult): AgentRunResult {
  try {
    const envelope = JSON.parse(result.output) as ClaudeJsonEnvelope;
    if (typeof envelope.result !== "string") return result;

    return {
      ...result,
      output: envelope.result,
      usage: {
        inputTokens: envelope.usage?.input_tokens,
        outputTokens: envelope.usage?.output_tokens,
        cacheReadTokens: envelope.usage?.cache_read_input_tokens,
        cacheCreationTokens: envelope.usage?.cache_creation_input_tokens,
        thinkingTokens: envelope.usage?.output_tokens_details?.thinking_tokens,
        costUsd: envelope.total_cost_usd,
      },
    };
  } catch {
    return result;
  }
}
