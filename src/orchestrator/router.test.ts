import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/claudeCode.js", () => ({ runClaudeCode: vi.fn() }));

import { runClaudeCode } from "../agents/claudeCode.js";
import type { AgentRunResult } from "../types.js";
import { classifyTaskWithClaude, parseTaskAgentPrefix, planTask } from "./router.js";

const mockedRunClaudeCode = vi.mocked(runClaudeCode);

function fakeClassifyResult(output: string): AgentRunResult {
  return {
    agent: "claude",
    prompt: "prompt de classificação",
    output,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.500Z",
    durationMs: 500,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("planTask", () => {
  it("retorna uma etapa antigravity quando só há sinais de pesquisa", () => {
    const task = "pesquisar a última versão do node";
    expect(planTask(task)).toEqual([{ agent: "antigravity", prompt: task }]);
  });

  it("retorna uma etapa claude quando só há sinais de implementação", () => {
    const task = "implementar um arquivo novo";
    expect(planTask(task)).toEqual([{ agent: "claude", prompt: task }]);
  });

  it("retorna duas etapas, pesquisa seguida de implementação, quando há sinais de ambos", () => {
    const task = "pesquisar a versão do node e implementar um upgrade";
    expect(planTask(task)).toEqual([
      { agent: "antigravity", prompt: task },
      { agent: "claude", prompt: task },
    ]);
  });

  it("retorna array vazio quando a tarefa é ambígua (nenhum agente identificado)", () => {
    expect(planTask("boa tarde, tudo bem?")).toEqual([]);
  });

  it("é case-insensitive na detecção das palavras-chave", () => {
    const task = "IMPLEMENTAR um novo endpoint";
    expect(planTask(task)).toEqual([{ agent: "claude", prompt: task }]);
  });
});

describe("parseTaskAgentPrefix", () => {
  it('reconhece "claude:" e "antigravity:" no início, removendo o prefixo do texto', () => {
    expect(parseTaskAgentPrefix("claude: implementar um endpoint")).toEqual({
      agent: "claude",
      text: "implementar um endpoint",
    });
    expect(parseTaskAgentPrefix("antigravity: pesquisar node")).toEqual({
      agent: "antigravity",
      text: "pesquisar node",
    });
  });

  it("é case-insensitive e tolera espaço antes do ':'", () => {
    expect(parseTaskAgentPrefix("CLAUDE: implementar X")).toEqual({ agent: "claude", text: "implementar X" });
    expect(parseTaskAgentPrefix("Antigravity : pesquisar Y")).toEqual({
      agent: "antigravity",
      text: "pesquisar Y",
    });
  });

  it("sem prefixo, devolve o texto original intacto e nenhum agente", () => {
    expect(parseTaskAgentPrefix("implementar um endpoint de login")).toEqual({
      text: "implementar um endpoint de login",
    });
  });

  it("frase comum com ':' no meio (não logo após a primeira palavra) não é tratada como prefixo", () => {
    const task = "corrigir bug: o app trava ao abrir";
    expect(parseTaskAgentPrefix(task)).toEqual({ text: task });
  });

  it("nome de agente desconhecido no formato de prefixo é sinalizado como inválido, sem alterar o texto", () => {
    const task = "foo: implementar algo";
    expect(parseTaskAgentPrefix(task)).toEqual({ text: task, invalidAgentName: "foo" });
  });
});

describe("classifyTaskWithClaude", () => {
  const task = "boa tarde, tudo bem?";

  it('monta um plano de uma etapa (antigravity) quando o claude classifica como "pesquisa"', async () => {
    mockedRunClaudeCode.mockResolvedValue(fakeClassifyResult("pesquisa"));

    await expect(classifyTaskWithClaude(task)).resolves.toEqual([{ agent: "antigravity", prompt: task }]);
  });

  it('monta um plano de uma etapa (claude) quando o claude classifica como "implementação" (com acento e pontuação)', async () => {
    mockedRunClaudeCode.mockResolvedValue(fakeClassifyResult("Implementação."));

    await expect(classifyTaskWithClaude(task)).resolves.toEqual([{ agent: "claude", prompt: task }]);
  });

  it('monta um plano de duas etapas quando o claude classifica como "ambos"', async () => {
    mockedRunClaudeCode.mockResolvedValue(fakeClassifyResult("ambos"));

    await expect(classifyTaskWithClaude(task)).resolves.toEqual([
      { agent: "antigravity", prompt: task },
      { agent: "claude", prompt: task },
    ]);
  });

  it("retorna null quando a chamada ao claude falha", async () => {
    mockedRunClaudeCode.mockRejectedValue(new Error("timeout"));

    await expect(classifyTaskWithClaude(task)).resolves.toBeNull();
  });

  it("retorna null quando a resposta não é uma das três classificações esperadas", async () => {
    mockedRunClaudeCode.mockResolvedValue(fakeClassifyResult("não sei dizer, pode ser qualquer coisa"));

    await expect(classifyTaskWithClaude(task)).resolves.toBeNull();
  });
});

describe("prefixos de colaboração", () => {
  it("reconhece Codex e sequências com espaços, caixa e agentes repetidos", () => {
    expect(parseTaskAgentPrefix("codex: implementar")).toEqual({ agent: "codex", text: "implementar" });
    expect(parseTaskAgentPrefix("Claude > CODEX > claude: revisar")).toEqual({ agents: ["claude", "codex", "claude"], text: "revisar" });
  });
  it.each(["codex>>claude: implementar", "codex>: implementar", "codex>foo: implementar"])("rejeita sequência inválida: %s", (task) => {
    expect(parseTaskAgentPrefix(task).invalidAgentName).toBeTruthy();
  });
});
