import { describe, expect, it } from "vitest";
import { accumulate, budgetExceeded, validateBudget } from "./budget.js";
import type { AgentRunResult } from "../types.js";

function step(costUsd?: number): AgentRunResult {
  return {
    agent: "claude", prompt: "p", output: "o", durationMs: 1,
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z",
    ...(costUsd === undefined ? {} : { usage: { costUsd } }),
  };
}

describe("accumulate", () => {
  it("soma só as etapas que reportaram custo e conta a cobertura", () => {
    const usage = accumulate([step(0.10), step(undefined), step(0.05), undefined], 1234);
    expect(usage.costUsd).toBeCloseTo(0.15);
    expect(usage.reportingSteps).toBe(2);
    expect(usage.totalSteps).toBe(3); // o `undefined` é tarefa que nem rodou
    expect(usage.elapsedMs).toBe(1234);
  });

  it("sem nenhuma etapa, o acumulado é zero", () => {
    expect(accumulate([], 0)).toEqual({ costUsd: 0, reportingSteps: 0, totalSteps: 0, elapsedMs: 0 });
  });
});

describe("budgetExceeded", () => {
  it("sem orçamento, nunca interrompe", () => {
    expect(budgetExceeded(undefined, accumulate([step(999)], 10 ** 9))).toBeUndefined();
  });

  it("segue enquanto está abaixo dos dois tetos", () => {
    const usage = accumulate([step(0.10)], 1000);
    expect(budgetExceeded({ maxCostUsd: 1, maxDurationMs: 60_000 }, usage)).toBeUndefined();
  });

  it("interrompe ao atingir o teto de tempo, com os números na mensagem", () => {
    const motivo = budgetExceeded({ maxDurationMs: 30_000 }, accumulate([], 30_000));
    expect(motivo).toContain("Tempo limite");
    expect(motivo).toContain("30s");
  });

  it("interrompe ao atingir o teto de custo", () => {
    const motivo = budgetExceeded({ maxCostUsd: 0.5 }, accumulate([step(0.3), step(0.25)], 10));
    expect(motivo).toContain("Orçamento");
    expect(motivo).toContain("0.55");
  });

  // O ponto mais importante da mensagem: só o claude reporta custo, então um
  // número parcial não pode ser apresentado como se fosse o gasto total.
  it("avisa que a medição é parcial quando nem toda etapa reportou custo", () => {
    const motivo = budgetExceeded({ maxCostUsd: 0.1 }, accumulate([step(0.2), step(undefined)], 10));
    expect(motivo).toContain("1 de 2 etapas");
    expect(motivo).toContain("o gasto real é maior");
  });

  it("não avisa de medição parcial quando todas as etapas reportaram", () => {
    const motivo = budgetExceeded({ maxCostUsd: 0.1 }, accumulate([step(0.2)], 10));
    expect(motivo).not.toContain("gasto real é maior");
  });

  it("tempo vence custo quando os dois estouram (a medição de tempo é confiável)", () => {
    const motivo = budgetExceeded({ maxCostUsd: 0.01, maxDurationMs: 1 }, accumulate([step(9)], 10_000));
    expect(motivo).toContain("Tempo limite");
  });
});

describe("validateBudget", () => {
  it("aceita ausência de orçamento e valores positivos", () => {
    expect(() => validateBudget(undefined)).not.toThrow();
    expect(() => validateBudget({ maxCostUsd: 1.5, maxDurationMs: 1000 })).not.toThrow();
  });

  it("rejeita valores sem sentido antes de qualquer agente rodar", () => {
    expect(() => validateBudget({ maxCostUsd: 0 })).toThrow("positivo");
    expect(() => validateBudget({ maxCostUsd: -1 })).toThrow("positivo");
    expect(() => validateBudget({ maxCostUsd: Number.NaN })).toThrow("positivo");
    expect(() => validateBudget({ maxDurationMs: 0 })).toThrow("positivo");
    expect(() => validateBudget({ maxDurationMs: 1.5 })).toThrow("positivo");
  });
});
