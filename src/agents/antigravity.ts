import { runAgentCommand } from "./shared.js";
import type { AgentRunOptions, AgentRunResult } from "../types.js";

export async function runAntigravity(options: AgentRunOptions): Promise<AgentRunResult> {
  const prompt = options.context ? `${options.context}\n\n${options.prompt}` : options.prompt;

  return runAgentCommand({
    agent: "antigravity",
    command: "agy",
    args: ["-p", prompt, "--print-timeout", "3m"],
    prompt,
    timeoutMs: options.timeoutMs,
  });
}
