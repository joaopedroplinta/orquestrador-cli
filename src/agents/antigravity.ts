import { runAgentCommand } from "./shared.js";
import type { AgentRunOptions, AgentRunResult } from "../types.js";

// Deliberadamente SEM `--output-format json` aqui, diferente do
// claudeCode.ts — confirmado via probe manual (CLAUDE.md) que `agy -p
// --output-format json` TAMBÉM expõe uso de tokens (`usage.input_tokens`/
// `output_tokens`/etc.), mas troca o streaming real (5-9 chunks conforme a
// resposta é gerada) por um único chunk gigante no final, igual ao modo
// json do claude. Como o antigravity é o único agente com streaming real
// hoje, priorizamos preservar isso em vez de ganhar tracking de uso —
// trade-off consciente, não uma limitação técnica sem solução. Se algum
// dia isso mudar (ex.: usar `--output-format stream-json` com parsing de
// NDJSON em vez de bytes crus), revisitar essa decisão.
export async function runAntigravity(options: AgentRunOptions): Promise<AgentRunResult> {
  const prompt = options.context ? `${options.context}\n\n${options.prompt}` : options.prompt;

  return runAgentCommand({
    agent: "antigravity",
    command: "agy",
    args: ["-p", prompt, "--print-timeout", "3m"],
    prompt,
    timeoutMs: options.timeoutMs,
    onChunk: options.onChunk,
    maxRetries: options.maxRetries,
    retryBaseDelayMs: options.retryBaseDelayMs,
    onRetry: options.onRetry,
  });
}
