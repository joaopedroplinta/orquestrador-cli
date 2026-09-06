import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { computeSessionStats, exportSessionToFile } from "./sessionStats.js";
import type { HistoryRun } from "./types.js";

const sampleRun: HistoryRun = {
  id: "run-1",
  task: "pesquisar e implementar auth",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:02.000Z",
  steps: [
    {
      id: 1,
      runId: "run-1",
      agent: "antigravity",
      prompt: "pesquisar auth",
      output: "pesquisa pronta",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
    },
    {
      id: 2,
      runId: "run-1",
      agent: "claude",
      prompt: "implementar auth",
      output: "codigo implementado",
      startedAt: "2026-01-01T00:00:01.000Z",
      finishedAt: "2026-01-01T00:00:02.000Z",
      durationMs: 1000,
      usage: { costUsd: 0.05 },
    },
  ],
};

describe("sessionStats", () => {
  it("computeSessionStats calcula estatísticas consolidadas", () => {
    const stats = computeSessionStats([sampleRun]);
    expect(stats.totalRuns).toBe(1);
    expect(stats.totalSteps).toBe(2);
    expect(stats.totalDurationMs).toBe(2000);
    expect(stats.totalCostUsd).toBe(0.05);
    expect(stats.agentBreakdown.antigravity.steps).toBe(1);
    expect(stats.agentBreakdown.claude.steps).toBe(1);
  });

  it("exportSessionToFile exporta arquivo markdown", () => {
    const { filepath, count } = exportSessionToFile([sampleRun], "markdown", tmpdir());
    expect(count).toBe(1);
    expect(existsSync(filepath)).toBe(true);
    unlinkSync(filepath);
  });

  it("exportSessionToFile exporta arquivo json", () => {
    const { filepath, count } = exportSessionToFile([sampleRun], "json", tmpdir());
    expect(count).toBe(1);
    expect(existsSync(filepath)).toBe(true);
    unlinkSync(filepath);
  });
});
