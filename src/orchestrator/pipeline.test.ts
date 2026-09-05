import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { runPipeline, runPipelines } from "./pipeline.js";

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

describe("runPipeline — retry", () => {
  it("loga no histórico as tentativas que falharam antes do sucesso final", async () => {
    const result = fakeResult("claude", "deu certo na terceira");
    result.retries = [
      { attempt: 1, kind: "nonzero_exit", message: "falhou 1", delayMs: 1000, timestamp: "t1" },
      { attempt: 2, kind: "timeout", message: "falhou 2", delayMs: 2000, timestamp: "t2" },
    ];
    mockedRunClaudeCode.mockResolvedValue(result);

    await runPipeline({ task: "implementar algo" });

    expect(mockedLogStep).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ agent: "claude", retries: result.retries }),
    );
  });

  it("propaga maxRetries e um onRetry marcado com o agente certo pro wrapper", async () => {
    mockedRunAntigravity.mockResolvedValue(fakeResult("antigravity", "pesquisa ok"));
    mockedRunClaudeCode.mockResolvedValue(fakeResult("claude", "implementação ok"));

    const onRetry = vi.fn();
    const task = "pesquisar a versão do node e implementar um upgrade";
    await runPipeline({ task, maxRetries: 5, onRetry });

    expect(mockedRunAntigravity).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 5, onRetry: expect.any(Function) }),
    );
    expect(mockedRunClaudeCode).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 5, onRetry: expect.any(Function) }),
    );

    // Simula o wrapper chamando onRetry de verdade — pipeline.ts precisa
    // repassar isso pro chamador já marcado com qual agente foi.
    const antigravityOnRetry = mockedRunAntigravity.mock.calls[0]?.[0].onRetry;
    antigravityOnRetry?.({ attempt: 1, kind: "timeout", message: "lento", delayMs: 1000, timestamp: "t", maxRetries: 5 });
    expect(onRetry).toHaveBeenCalledWith(
      "antigravity",
      expect.objectContaining({ attempt: 1, kind: "timeout", maxRetries: 5 }),
    );
  });

  it("esgotamento de tentativas: loga o erro final no histórico junto com o retries acumulado", async () => {
    const error = new AgentError("claude", "nonzero_exit", "continua falhando", undefined, [
      { attempt: 1, kind: "nonzero_exit", message: "falhou 1", delayMs: 1000, timestamp: "t1" },
      { attempt: 2, kind: "nonzero_exit", message: "falhou 2", delayMs: 2000, timestamp: "t2" },
      { attempt: 3, kind: "nonzero_exit", message: "falhou 3", delayMs: 4000, timestamp: "t3" },
    ]);
    mockedRunClaudeCode.mockRejectedValue(error);

    await expect(runPipeline({ task: "implementar algo" })).rejects.toBe(error);

    expect(mockedLogStep).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        agent: "claude",
        error: "nonzero_exit: continua falhando",
        retries: error.retries,
      }),
    );
  });

  it("erro não-elegível (ex: invalid_argument) propaga sem retries acumulados, já que o wrapper nem tentou de novo", async () => {
    const error = new AgentError("antigravity", "invalid_argument", "argumento inválido");
    mockedRunAntigravity.mockRejectedValue(error);

    await expect(runPipeline({ task: "pesquisar algo" })).rejects.toBe(error);

    expect(mockedLogStep).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ agent: "antigravity", retries: undefined }),
    );
  });
});

describe("runPipeline — prefixo de agente por tarefa (\"claude:\"/\"antigravity:\")", () => {
  it('prefixo "claude:" força o agente e remove o prefixo do prompt enviado', async () => {
    mockedRunClaudeCode.mockResolvedValue(fakeResult("claude", "ok"));

    const result = await runPipeline({ task: "claude: pesquisar node, já que tem sinal de pesquisa" });

    expect(mockedRunClaudeCode).toHaveBeenCalledWith({
      prompt: "pesquisar node, já que tem sinal de pesquisa",
      context: undefined,
    });
    expect(mockedRunAntigravity).not.toHaveBeenCalled();
    expect(result.task).toBe("pesquisar node, já que tem sinal de pesquisa");
    expect(mockedStartRun).toHaveBeenCalledWith("pesquisar node, já que tem sinal de pesquisa");
  });

  it("sem prefixo continua caindo no roteamento normal por palavra-chave", async () => {
    mockedRunAntigravity.mockResolvedValue(fakeResult("antigravity", "ok"));

    const result = await runPipeline({ task: "pesquisar node" });

    expect(mockedRunAntigravity).toHaveBeenCalledWith({ prompt: "pesquisar node", context: undefined });
    expect(result.task).toBe("pesquisar node");
  });

  it("--agent (forceAgent global) tem prioridade sobre o prefixo por tarefa", async () => {
    mockedRunAntigravity.mockResolvedValue(fakeResult("antigravity", "ok"));

    await runPipeline({ task: "claude: implementar algo", forceAgent: "antigravity" });

    expect(mockedRunAntigravity).toHaveBeenCalledWith({ prompt: "implementar algo", context: undefined });
    expect(mockedRunClaudeCode).not.toHaveBeenCalled();
  });

  it("prefixo com nome de agente inválido lança um erro claro, sem chamar nenhum agente nem abrir run", async () => {
    await expect(runPipeline({ task: "foo: implementar algo" })).rejects.toThrow(
      /Prefixo de agente inválido: "foo:"/,
    );

    expect(mockedRunClaudeCode).not.toHaveBeenCalled();
    expect(mockedRunAntigravity).not.toHaveBeenCalled();
    expect(mockedStartRun).not.toHaveBeenCalled();
  });
});

describe("runPipelines — prefixo de agente por tarefa", () => {
  it("cada tarefa do lote pode forçar um agente diferente via prefixo, mesmo sem --agent/--auto global", async () => {
    mockedStartRun.mockImplementation((task: string) => `run-${task}`);
    mockedRunClaudeCode.mockResolvedValue(fakeResult("claude", "implementação ok"));
    mockedRunAntigravity.mockResolvedValue(fakeResult("antigravity", "pesquisa ok"));

    const results = await runPipelines({
      tasks: ["claude: implementar X", "antigravity: implementar Y"],
    });

    // A segunda tarefa tem keyword de implementação ("implementar"), mas o
    // prefixo "antigravity:" força o outro agente mesmo assim.
    expect(mockedRunClaudeCode).toHaveBeenCalledWith({ prompt: "implementar X", context: undefined });
    expect(mockedRunAntigravity).toHaveBeenCalledWith({ prompt: "implementar Y", context: undefined });
    expect(results[0]!.result?.steps[0]?.agent).toBe("claude");
    expect(results[1]!.result?.steps[0]?.agent).toBe("antigravity");
  });

  it("tarefa com prefixo de agente inválido vira um resultado de erro pontual, sem afetar as outras do lote", async () => {
    mockedStartRun.mockImplementation((task: string) => `run-${task}`);
    mockedRunClaudeCode.mockResolvedValue(fakeResult("claude", "ok"));

    const results = await runPipelines({ tasks: ["foo: implementar algo", "claude: implementar outra coisa"] });

    expect(results[0]!.error).toBeInstanceOf(Error);
    expect((results[0]!.error as Error).message).toMatch(/Prefixo de agente inválido: "foo:"/);
    expect(results[0]!.result).toBeUndefined();
    expect(mockedStartRun).not.toHaveBeenCalledWith("run-foo: implementar algo");

    expect(results[1]!.error).toBeUndefined();
    expect(results[1]!.result?.steps[0]?.agent).toBe("claude");
  });

  it("--agent global sobrescreve o prefixo por tarefa pro lote inteiro", async () => {
    mockedStartRun.mockImplementation((task: string) => `run-${task}`);
    mockedRunAntigravity.mockResolvedValue(fakeResult("antigravity", "ok"));

    await runPipelines({ tasks: ["claude: tarefa 1", "claude: tarefa 2"], forceAgent: "antigravity" });

    expect(mockedRunAntigravity).toHaveBeenCalledTimes(2);
    expect(mockedRunClaudeCode).not.toHaveBeenCalled();
  });
});

describe("runPipeline — streaming", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("onStepStart e onStepComplete disparam pra cada etapa, na ordem certa", async () => {
    mockedRunAntigravity.mockResolvedValue(fakeResult("antigravity", "resultado da pesquisa"));
    mockedRunClaudeCode.mockResolvedValue(fakeResult("claude", "implementação feita"));

    const events: string[] = [];
    const onStepStart = vi.fn((agent: string) => events.push(`start:${agent}`));
    const onStepComplete = vi.fn((result: AgentRunResult) => events.push(`complete:${result.agent}`));

    const task = "pesquisar a versão do node e implementar um upgrade";
    await runPipeline({ task, onStepStart, onStepComplete });

    expect(events).toEqual(["start:antigravity", "complete:antigravity", "start:claude", "complete:claude"]);
  });

  it("repassa chunks reais pro agente que streama de verdade (antigravity), sem passar pela simulação", async () => {
    mockedRunAntigravity.mockImplementation(async (opts) => {
      opts.onChunk?.("pedaço 1 ");
      opts.onChunk?.("pedaço 2");
      return fakeResult("antigravity", "pedaço 1 pedaço 2");
    });

    const chunks: Array<[string, string]> = [];
    const onChunk = vi.fn((agent: string, chunk: string) => chunks.push([agent, chunk]));

    await runPipeline({ task: "pesquisar node", onChunk });

    expect(chunks).toEqual([
      ["antigravity", "pedaço 1 "],
      ["antigravity", "pedaço 2"],
    ]);
  });

  it("simula a revelação progressiva pro agente que não streama (claude), sem perder nem duplicar texto", async () => {
    vi.useFakeTimers();
    const fullText =
      "Este é um texto de resultado razoavelmente longo pra testar a simulação de streaming em pedaços, sem depender de nenhum chunk real vindo do processo.";
    mockedRunClaudeCode.mockResolvedValue(fakeResult("claude", fullText));

    const chunks: string[] = [];
    const onChunk = vi.fn((_agent: string, chunk: string) => chunks.push(chunk));

    const pending = runPipeline({ task: "implementar algo", onChunk });
    await vi.runAllTimersAsync();
    await pending;

    expect(chunks.length).toBeGreaterThan(1); // realmente virou vários pedaços, não um só
    expect(chunks.join("")).toBe(fullText); // nada perdido nem duplicado ao juntar de volta
    expect(chunks[0]!.length).toBeLessThan(fullText.length); // nunca entrega tudo de uma vez
  });

  it("onStepComplete de uma etapa bem-sucedida dispara mesmo se a etapa seguinte falhar depois", async () => {
    mockedRunAntigravity.mockResolvedValue(fakeResult("antigravity", "pesquisa ok"));
    const error = new AgentError("claude", "timeout", "excedeu o timeout");
    mockedRunClaudeCode.mockRejectedValue(error);

    const onStepComplete = vi.fn();
    const task = "pesquisar a versão do node e implementar um upgrade";

    await expect(runPipeline({ task, onStepComplete })).rejects.toBe(error);

    expect(onStepComplete).toHaveBeenCalledTimes(1);
    expect(onStepComplete).toHaveBeenCalledWith(expect.objectContaining({ agent: "antigravity" }));
  });
});

describe("runPipelines", () => {
  it("roda várias tarefas independentes concorrentemente e mantém o mapeamento tarefa -> resultado", async () => {
    mockedStartRun.mockImplementation((task: string) => `run-${task}`);
    mockedRunAntigravity.mockResolvedValue(fakeResult("antigravity", "resultado pesquisa"));
    mockedRunClaudeCode.mockResolvedValue(fakeResult("claude", "resultado implementação"));

    const tasks = ["pesquisar X", "implementar Y"];
    const results = await runPipelines({ tasks });

    expect(results).toHaveLength(2);
    expect(results[0]!.task).toBe("pesquisar X");
    expect(results[0]!.result?.steps[0]?.agent).toBe("antigravity");
    expect(results[1]!.task).toBe("implementar Y");
    expect(results[1]!.result?.steps[0]?.agent).toBe("claude");
    expect(mockedRunAntigravity).toHaveBeenCalledWith({ prompt: "pesquisar X", context: undefined });
    expect(mockedRunClaudeCode).toHaveBeenCalledWith({ prompt: "implementar Y", context: undefined });
  });

  it("reporta falha parcial sem afetar a tarefa que teve sucesso", async () => {
    mockedStartRun.mockImplementation((task: string) => `run-${task}`);
    mockedRunAntigravity.mockResolvedValue(fakeResult("antigravity", "ok"));
    const error = new AgentError("claude", "timeout", "excedeu o timeout");
    mockedRunClaudeCode.mockRejectedValue(error);

    const results = await runPipelines({ tasks: ["pesquisar X", "implementar Y"] });

    expect(results[0]!.error).toBeUndefined();
    expect(results[0]!.result?.steps).toHaveLength(1);
    expect(results[1]!.error).toBe(error);
    expect(results[1]!.result).toBeUndefined();
    expect(mockedFinishRun).toHaveBeenCalledWith("run-pesquisar X");
    expect(mockedFinishRun).toHaveBeenCalledWith("run-implementar Y");
  });

  it("onTaskRetry chega marcado com o índice e o agente certos da tarefa que precisou retentar", async () => {
    mockedStartRun.mockImplementation((task: string) => `run-${task}`);
    mockedRunAntigravity.mockResolvedValue(fakeResult("antigravity", "ok"));
    mockedRunClaudeCode.mockResolvedValue(fakeResult("claude", "ok"));

    const onTaskRetry = vi.fn();
    await runPipelines({ tasks: ["pesquisar X", "implementar Y"], maxRetries: 7, onTaskRetry });

    expect(mockedRunAntigravity).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 7 }));

    // Dispara o onRetry que o pipeline passou pro wrapper da segunda tarefa
    // (índice 1, claude) e confirma que chega no callback do lote já com o
    // índice/agente certos, sem precisar de N chamadas separadas.
    const claudeOnRetry = mockedRunClaudeCode.mock.calls[0]?.[0].onRetry;
    claudeOnRetry?.({ attempt: 2, kind: "timeout", message: "lento", delayMs: 2000, timestamp: "t", maxRetries: 7 });

    expect(onTaskRetry).toHaveBeenCalledWith(
      1,
      "claude",
      expect.objectContaining({ attempt: 2, kind: "timeout", maxRetries: 7 }),
    );
  });

  it("tarefa ambígua no lote vira um resultado de erro, sem derrubar as outras nem abrir um run pra ela", async () => {
    mockedStartRun.mockImplementation((task: string) => `run-${task}`);
    mockedRunAntigravity.mockResolvedValue(fakeResult("antigravity", "ok"));

    const results = await runPipelines({ tasks: ["pesquisar X", "boa tarde, tudo bem?"] });

    expect(results[0]!.error).toBeUndefined();
    expect(results[1]!.error).toBeInstanceOf(Error);
    expect((results[1]!.error as Error).message).toMatch(/Não foi possível decidir/);
    expect(mockedStartRun).not.toHaveBeenCalledWith("boa tarde, tudo bem?");
  });

  it("roda as tarefas de verdade em paralelo, não em sequência", async () => {
    mockedStartRun.mockImplementation((task: string) => `run-${task}`);
    const DELAY_MS = 80;
    mockedRunAntigravity.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(fakeResult("antigravity", "ok")), DELAY_MS)),
    );
    mockedRunClaudeCode.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(fakeResult("claude", "ok")), DELAY_MS)),
    );

    const start = Date.now();
    await runPipelines({ tasks: ["pesquisar X", "implementar Y"] });
    const elapsed = Date.now() - start;

    // margem generosa (1.5x) pra não ficar flaky em CI; sequencial daria ~2x DELAY_MS
    expect(elapsed).toBeLessThan(DELAY_MS * 1.5);
  });
});

describe("runPipelines — streaming", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("onTaskStepStart/onTaskChunk/onTaskStepComplete chegam com o índice certo pra cada tarefa", async () => {
    // claude nunca recebe onChunk de verdade do wrapper (AGENT_STREAMS_INCREMENTALLY.claude
    // é false) — o chunk dele vem da simulação, disparada só depois do mock resolver.
    // Por isso task 0 (antigravity) verifica o texto exato do chunk, e task 1 (claude) só
    // verifica que ALGUM chunk chegou com o índice/agente certos.
    vi.useFakeTimers();
    mockedRunAntigravity.mockImplementation(async (opts) => {
      opts.onChunk?.("antigravity chunk");
      return fakeResult("antigravity", "resultado pesquisa");
    });
    mockedRunClaudeCode.mockResolvedValue(fakeResult("claude", "resultado implementação"));

    const starts: Array<[number, string]> = [];
    const chunks: Array<[number, string, string]> = [];
    const completes: Array<[number, string]> = [];

    const pending = runPipelines({
      tasks: ["pesquisar X", "implementar Y"],
      onTaskStepStart: (index, agent) => starts.push([index, agent]),
      onTaskChunk: (index, agent, chunk) => chunks.push([index, agent, chunk]),
      onTaskStepComplete: (index, result) => completes.push([index, result.agent]),
    });
    await vi.runAllTimersAsync();
    await pending;

    expect(starts).toEqual(
      expect.arrayContaining([
        [0, "antigravity"],
        [1, "claude"],
      ]),
    );
    expect(chunks).toContainEqual([0, "antigravity", "antigravity chunk"]);
    expect(chunks.some(([index, agent]) => index === 1 && agent === "claude")).toBe(true);
    expect(completes).toEqual(
      expect.arrayContaining([
        [0, "antigravity"],
        [1, "claude"],
      ]),
    );
  });

  it("chunks de duas tarefas concorrentes (uma real, outra simulada) não se misturam", async () => {
    // Tarefa 0 no antigravity (streaming real, intercalado no tempo via
    // "await Promise.resolve()" de propósito) e tarefa 1 no claude (simulado,
    // já que ele não escreve stdout aos poucos) — exatamente o cenário que a
    // TUI (App.tsx) precisa exibir ao mesmo tempo sem confundir qual é qual.
    vi.useFakeTimers();
    mockedRunAntigravity.mockImplementation(async (opts) => {
      opts.onChunk?.("A1 ");
      await Promise.resolve();
      opts.onChunk?.("A2 ");
      await Promise.resolve();
      opts.onChunk?.("A3");
      return fakeResult("antigravity", "A1 A2 A3");
    });
    const claudeText = "texto completo do claude, revelado aos poucos só pela simulação, não chunk real";
    mockedRunClaudeCode.mockResolvedValue(fakeResult("claude", claudeText));

    const chunksByTask: Record<number, string[]> = { 0: [], 1: [] };
    const pending = runPipelines({
      tasks: ["pesquisar X", "implementar Y"],
      onTaskChunk: (index, _agent, chunk) => {
        chunksByTask[index] = [...(chunksByTask[index] ?? []), chunk];
      },
    });
    await vi.runAllTimersAsync();
    await pending;

    expect(chunksByTask[0]).toEqual(["A1 ", "A2 ", "A3"]);
    expect(chunksByTask[1]!.length).toBeGreaterThan(1); // realmente fragmentado pela simulação
    expect(chunksByTask[1]!.join("")).toBe(claudeText); // sem perda nem mistura com a tarefa 0
  });

  it("tarefa ambígua no lote continua virando erro em vez de prompt, mesmo com callbacks de streaming presentes", async () => {
    mockedRunAntigravity.mockResolvedValue(fakeResult("antigravity", "ok"));
    const onTaskStepStart = vi.fn();

    const results = await runPipelines({
      tasks: ["pesquisar X", "boa tarde, tudo bem?"],
      onTaskStepStart,
    });

    expect(results[1]!.error).toBeInstanceOf(Error);
    expect((results[1]!.error as Error).message).toMatch(/Não foi possível decidir/);
    // onStepStart nunca chegou a ser chamado pra essa tarefa (nunca teve plano)
    expect(onTaskStepStart).toHaveBeenCalledTimes(1);
    expect(onTaskStepStart).toHaveBeenCalledWith(0, "antigravity");
  });
});
