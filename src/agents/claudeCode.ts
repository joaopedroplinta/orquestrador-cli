import { runAgentCommand } from "./shared.js";
import type { AgentRunOptions, AgentRunResult } from "../types.js";

export async function runClaudeCode(options: AgentRunOptions): Promise<AgentRunResult> {
  const prompt = options.context ? `${options.context}\n\n${options.prompt}` : options.prompt;

  return runAgentCommand({
    agent: "claude",
    command: "claude",
    args: ["-p", prompt],
    prompt,
    timeoutMs: options.timeoutMs,
  });
}
