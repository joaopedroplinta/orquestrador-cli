import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMarkdownReport } from "./reporting.js";
import type { AgentName, HistoryRun } from "./types.js";

export interface SessionStats {
  totalRuns: number;
  totalSteps: number;
  totalDurationMs: number;
  totalCostUsd: number;
  agentBreakdown: Record<AgentName, { steps: number; durationMs: number }>;
}

export function computeSessionStats(runs: HistoryRun[]): SessionStats {
  const stats: SessionStats = {
    totalRuns: runs.length,
    totalSteps: 0,
    totalDurationMs: 0,
    totalCostUsd: 0,
    agentBreakdown: {
      claude: { steps: 0, durationMs: 0 },
      antigravity: { steps: 0, durationMs: 0 },
    },
  };

  for (const run of runs) {
    for (const step of run.steps) {
      stats.totalSteps += 1;
      stats.totalDurationMs += step.durationMs;
      if (step.usage?.costUsd) {
        stats.totalCostUsd += step.usage.costUsd;
      }
      if (stats.agentBreakdown[step.agent]) {
        stats.agentBreakdown[step.agent].steps += 1;
        stats.agentBreakdown[step.agent].durationMs += step.durationMs;
      }
    }
  }

  return stats;
}

export function exportSessionToFile(
  runs: HistoryRun[],
  format: "markdown" | "json" = "markdown",
  destinationDir: string = process.cwd(),
): { filepath: string; count: number } {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `orquestrador-session-${timestamp}.${format === "json" ? "json" : "md"}`;
  const filepath = join(destinationDir, filename);

  if (format === "json") {
    writeFileSync(filepath, JSON.stringify(runs, null, 2), "utf-8");
  } else {
    const markdown = runs.map((run) => buildMarkdownReport(run)).join("\n\n---\n\n");
    writeFileSync(filepath, markdown, "utf-8");
  }

  return { filepath, count: runs.length };
}
