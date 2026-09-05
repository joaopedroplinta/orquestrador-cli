import { describe, expect, it } from "vitest";
import { buildMarkdownReport } from "./reporting.js";
import type { HistoryRun, HistoryStep } from "./types.js";

function fakeStep(overrides: Partial<HistoryStep> = {}): HistoryStep {
  return {
    id: 1,
    runId: "run-1",
    agent: "antigravity",
    prompt: "pesquisar X",
    output: "resultado da pesquisa",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:06.000Z",
    durationMs: 6000,
    ...overrides,
  };
}

function fakeRun(overrides: Partial<HistoryRun> = {}): HistoryRun {
  return {
    id: "abcdef12-3456-7890-abcd-ef1234567890",
    task: "pesquisar X",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:06.000Z",
    steps: [fakeStep()],
    ...overrides,
  };
}

describe("buildMarkdownReport", () => {
  it("inclui título, metadados do run, e uma seção por etapa com prompt/output em blocos de código", () => {
    const run = fakeRun({
      steps: [
        fakeStep({ id: 1, agent: "antigravity", prompt: "pesquisar X", output: "resultado da pesquisa", durationMs: 6000 }),
        fakeStep({
          id: 2,
          agent: "claude",
          prompt: "implementar Y",
          output: "implementação feita",
          durationMs: 10500,
          fedByStepId: 1,
        }),
      ],
    });

    const report = buildMarkdownReport(run);

    expect(report).toContain(`# Relatório de execução — ${run.task}`);
    expect(report).toContain(`\`${run.id}\``);
    expect(report).toContain(`**Início:** ${run.startedAt}`);
    expect(report).toContain(`**Fim:** ${run.finishedAt}`);
    expect(report).toContain("**Etapas:** 2");

    expect(report).toContain("## Etapa 1 — antigravity (6.0s)");
    expect(report).toContain("pesquisar X");
    expect(report).toContain("resultado da pesquisa");

    expect(report).toContain("## Etapa 2 — claude (10.5s) — alimentada pela etapa #1");
    expect(report).toContain("implementar Y");
    expect(report).toContain("implementação feita");
  });

  it("execução não finalizada mostra isso explicitamente em vez de um campo vazio", () => {
    const run = fakeRun({ finishedAt: undefined });
    expect(buildMarkdownReport(run)).toContain("**Fim:** (execução não finalizada)");
  });

  it("etapa com erro mostra a mensagem de erro em vez de uma seção de Output", () => {
    const run = fakeRun({
      steps: [fakeStep({ error: "timeout: excedeu o timeout de 180000ms", output: "" })],
    });

    const report = buildMarkdownReport(run);

    expect(report).toContain("**Erro:** timeout: excedeu o timeout de 180000ms");
    expect(report).not.toContain("**Output:**");
  });

  it("etapa com retries vira uma tabela markdown, com '|' na mensagem escapado", () => {
    const run = fakeRun({
      steps: [
        fakeStep({
          retries: [
            { attempt: 1, kind: "timeout", message: "excedeu | com pipe", delayMs: 1000, timestamp: "t1" },
            { attempt: 2, kind: "nonzero_exit", message: "saiu com código 1", delayMs: 2000, timestamp: "t2" },
          ],
        }),
      ],
    });

    const report = buildMarkdownReport(run);

    expect(report).toContain("**Tentativas antes do resultado final:**");
    expect(report).toContain("| # | Tipo | Mensagem | Backoff até a próxima |");
    expect(report).toContain("| 1 | timeout | excedeu \\| com pipe | 1000ms |");
    expect(report).toContain("| 2 | nonzero_exit | saiu com código 1 | 2000ms |");
  });

  it("etapa sem retries não tem a seção de tentativas", () => {
    const report = buildMarkdownReport(fakeRun());
    expect(report).not.toContain("Tentativas antes do resultado final");
  });

  it("usage com tokens mas sem custo (ex.: antigravity) mostra só os tokens, sem custo total no resumo", () => {
    const run = fakeRun({
      steps: [fakeStep({ usage: { inputTokens: 5232, outputTokens: 24, cacheReadTokens: 8128 } })],
    });

    const report = buildMarkdownReport(run);

    expect(report).toContain("tokens: entrada 5232 · saída 24 · cache leitura 8128");
    expect(report).not.toContain("Custo total reportado");
    expect(report).not.toContain("custo US$");
  });

  it("usage com custo (ex.: claude) mostra o custo da etapa E o resumo de custo total do run", () => {
    const run = fakeRun({
      steps: [
        fakeStep({
          agent: "claude",
          usage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 16652, cacheCreationTokens: 13838, costUsd: 0.0890346 },
        }),
      ],
    });

    const report = buildMarkdownReport(run);

    expect(report).toContain("custo US$ 0.09");
    expect(report).toContain("**Custo total reportado:** US$ 0.09");
    expect(report).not.toContain("parcial");
  });

  it("custo abaixo de 1 centavo usa mais casas decimais, pra não arredondar pra US$ 0.00", () => {
    const run = fakeRun({ steps: [fakeStep({ agent: "claude", usage: { costUsd: 0.000945 } })] });
    expect(buildMarkdownReport(run)).toContain("custo US$ 0.0009");
  });

  it("custo parcial (só algumas etapas reportaram) avisa isso no resumo, sem fingir que é o custo total do run", () => {
    const run = fakeRun({
      steps: [
        fakeStep({ agent: "antigravity", usage: { inputTokens: 100, outputTokens: 20 } }),
        fakeStep({ agent: "claude", usage: { inputTokens: 2, outputTokens: 4, costUsd: 0.05 } }),
      ],
    });

    const report = buildMarkdownReport(run);

    expect(report).toContain("**Custo total reportado:** US$ 0.05 (1/2 etapas reportaram custo — parcial");
  });

  it("nenhuma etapa com usage: sem seção de tokens/custo em lugar nenhum", () => {
    const report = buildMarkdownReport(fakeRun());
    expect(report).not.toContain("tokens:");
    expect(report).not.toContain("Custo total reportado");
  });
});
