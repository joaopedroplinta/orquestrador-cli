import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentError, PipelineCancelledError, type AgentRunResult } from "../types.js";

vi.mock("../agents/claudeCode.js", () => ({ runClaudeCode: vi.fn() }));
vi.mock("../agents/antigravity.js", () => ({ runAntigravity: vi.fn() }));
vi.mock("../storage/history.js", () => ({
  startRun: vi.fn(),
  finishRun: vi.fn(),
  logStep: vi.fn(),
}));

import { runAntigravity } from "../agents/antigravity.js";
import { runClaudeCode } from "../agents/claudeCode.js";
import { finishRun, logStep, startRun } from "../storage/history.js";
import { runPipeline } from "./pipeline.js";

const mockedRunClaudeCode = vi.mocked(runClaudeCode);
const mockedRunAntigravity = vi.mocked(runAntigravity);
const mockedStartRun = vi.mocked(startRun);
const mockedFinishRun = vi.mocked(finishRun);
const mockedLogStep = vi.mocked(logStep);

function fakeResult(agent: "claude" | "antigravity", output: string): AgentRunResult {
  return {
    agent,
    prompt: `prompt enviado pro ${agent}`,
    output,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedStartRun.mockReturnValue("run-1");
  mockedLogStep.mockReturnValue(1);
});

describe("runPipeline", () => {
  it("roda só o agente forçado, ignorando o roteamento por palavras-chave", async () => {
    mockedRunAntigravity.mockResolvedValue(fakeResult("antigravity", "output antigravity"));

    const result = await runPipeline({ task: "qualquer coisa ambígua", forceAgent: "antigravity" });

    expect(mockedRunAntigravity).toHaveBeenCalledWith({
      prompt: "qualquer coisa ambígua",
      context: undefined,
    });
    expect(mockedRunClaudeCode).not.toHaveBeenCalled();
    expect(result.steps).toHaveLength(1);
    expect(mockedFinishRun).toHaveBeenCalledWith("run-1");
  });

  it("roda pesquisa e depois implementação em sequência, repassando o output da primeira como contexto da segunda", async () => {
    mockedRunAntigravity.mockResolvedValue(fakeResult("antigravity", "resultado da pesquisa"));
    mockedRunClaudeCode.mockResolvedValue(fakeResult("claude", "implementação feita"));
    mockedLogStep.mockReturnValueOnce(10).mockReturnValueOnce(11);

    const task = "pesquisar a versão do node e implementar um upgrade";
    const result = await runPipeline({ task });

    expect(mockedRunAntigravity).toHaveBeenCalledWith({ prompt: task, context: undefined });
    expect(mockedRunClaudeCode).toHaveBeenCalledWith({ prompt: task, context: "resultado da pesquisa" });
    expect(result.steps).toHaveLength(2);

    expect(mockedLogStep).toHaveBeenNthCalledWith(
      1,
      "run-1",
      expect.objectContaining({ agent: "antigravity", fedByStepId: undefined }),
    );
    expect(mockedLogStep).toHaveBeenNthCalledWith(
      2,
      "run-1",
      expect.objectContaining({ agent: "claude", fedByStepId: 10 }),
    );
  });

  it("lança erro e não chama nenhum agente nem abre um run quando a tarefa é ambígua e não há resolvedor", async () => {
    await expect(runPipeline({ task: "boa tarde, tudo bem?" })).rejects.toThrow(/Não foi possível decidir/);

    expect(mockedRunClaudeCode).not.toHaveBeenCalled();
    expect(mockedRunAntigravity).not.toHaveBeenCalled();
    expect(mockedStartRun).not.toHaveBeenCalled();
  });

  it("usa o agente escolhido pelo resolvedor de ambiguidade quando a tarefa é ambígua", async () => {
    mockedRunClaudeCode.mockResolvedValue(fakeResult("claude", "ok"));
    const resolveAmbiguousAgent = vi.fn().mockResolvedValue("claude");

    const result = await runPipeline({ task: "boa tarde, tudo bem?", resolveAmbiguousAgent });

    expect(resolveAmbiguousAgent).toHaveBeenCalledWith("boa tarde, tudo bem?");
    expect(mockedRunClaudeCode).toHaveBeenCalledWith({ prompt: "boa tarde, tudo bem?", context: undefined });
    expect(mockedRunAntigravity).not.toHaveBeenCalled();
    expect(result.steps).toHaveLength(1);
    expect(mockedStartRun).toHaveBeenCalledWith("boa tarde, tudo bem?");
  });

  it("lança PipelineCancelledError e não abre run quando o resolvedor de ambiguidade retorna null", async () => {
    const resolveAmbiguousAgent = vi.fn().mockResolvedValue(null);

    await expect(runPipeline({ task: "boa tarde, tudo bem?", resolveAmbiguousAgent })).rejects.toBeInstanceOf(
      PipelineCancelledError,
    );

    expect(mockedStartRun).not.toHaveBeenCalled();
    expect(mockedRunClaudeCode).not.toHaveBeenCalled();
    expect(mockedRunAntigravity).not.toHaveBeenCalled();
  });

  it("loga o erro da etapa e ainda finaliza o run quando um agente falha", async () => {
    const error = new AgentError("claude", "timeout", "excedeu o timeout");
    mockedRunClaudeCode.mockRejectedValue(error);

    await expect(runPipeline({ task: "implementar algo" })).rejects.toBe(error);

    expect(mockedLogStep).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ agent: "claude", error: "timeout: excedeu o timeout" }),
    );
    expect(mockedFinishRun).toHaveBeenCalledWith("run-1");
  });

  it("--agent tem prioridade sobre --auto: nunca classifica quando o agente é forçado", async () => {
    mockedRunAntigravity.mockResolvedValue(fakeResult("antigravity", "output antigravity"));

    const result = await runPipeline({ task: "boa tarde, tudo bem?", forceAgent: "antigravity", auto: true });

    expect(mockedRunClaudeCode).not.toHaveBeenCalled();
    expect(result.steps).toHaveLength(1);
  });

  it("com auto=true e tarefa ambígua, classifica via claude e roda o plano resultante", async () => {
    mockedRunClaudeCode
      .mockResolvedValueOnce(fakeResult("claude", "ambos")) // resposta da classificação
      .mockResolvedValueOnce(fakeResult("claude", "implementação feita")); // etapa real do plano
    mockedRunAntigravity.mockResolvedValue(fakeResult("antigravity", "resultado da pesquisa"));

    const task = "boa tarde, tudo bem?";
    const result = await runPipeline({ task, auto: true });

    expect(mockedRunClaudeCode).toHaveBeenCalledTimes(2);
    expect(mockedRunClaudeCode.mock.calls[0]?.[0].prompt).toContain("Classifique");
    expect(mockedRunAntigravity).toHaveBeenCalledWith({ prompt: task, context: undefined });
    expect(mockedRunClaudeCode.mock.calls[1]?.[0]).toEqual({ prompt: task, context: "resultado da pesquisa" });
    expect(result.steps).toHaveLength(2);
    expect(mockedStartRun).toHaveBeenCalledWith(task);
  });

  it("com auto=true, se a classificação falhar cai pro resolvedor de ambiguidade existente", async () => {
    mockedRunClaudeCode.mockRejectedValueOnce(new AgentError("claude", "timeout", "excedeu o timeout"));
    mockedRunAntigravity.mockResolvedValue(fakeResult("antigravity", "ok pesquisa"));
    const resolveAmbiguousAgent = vi.fn().mockResolvedValue("antigravity");

    const task = "boa tarde, tudo bem?";
    const result = await runPipeline({ task, auto: true, resolveAmbiguousAgent });

    expect(resolveAmbiguousAgent).toHaveBeenCalledWith(task);
    expect(mockedRunAntigravity).toHaveBeenCalledWith({ prompt: task, context: undefined });
    expect(result.steps).toHaveLength(1);
  });

  it("com auto=true, se a classificação vier com resposta inesperada cai pro resolvedor de ambiguidade", async () => {
    mockedRunClaudeCode.mockResolvedValueOnce(fakeResult("claude", "não sei dizer"));
    const resolveAmbiguousAgent = vi.fn().mockResolvedValue(null);

    const task = "boa tarde, tudo bem?";

    await expect(runPipeline({ task, auto: true, resolveAmbiguousAgent })).rejects.toBeInstanceOf(
      PipelineCancelledError,
    );

    expect(resolveAmbiguousAgent).toHaveBeenCalledWith(task);
  });
});
