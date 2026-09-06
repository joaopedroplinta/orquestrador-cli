import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentCommand } from "./shared.js";
import { AgentError } from "../types.js";

vi.mock("execa", () => ({ execa: vi.fn() }));

const mockedExeca = vi.mocked(execa);

function ok(stdout: string) {
  return { exitCode: 0, timedOut: false, failed: false, stdout, stderr: "" };
}

function failNonZero(stderr = "erro temporário de rede") {
  return { exitCode: 1, timedOut: false, failed: true, stdout: "", stderr };
}

// execa é chamado com `{ reject: false }`, então falhas de exit code chegam
// como resolução normal da promise (não uma rejeição) — só ENOENT e outras
// falhas de spawn de fato rejeitam a promise.
function asExecaResult(value: ReturnType<typeof ok> | ReturnType<typeof failNonZero>) {
  return Promise.resolve(value) as unknown as ReturnType<typeof execa>;
}

describe("runAgentCommand — retry com backoff", () => {
  afterEach(() => {
    vi.useRealTimers();
    mockedExeca.mockReset();
  });

  it("erro transitório (nonzero_exit) na primeira tentativa: sucesso na segunda", async () => {
    mockedExeca
      .mockReturnValueOnce(asExecaResult(failNonZero()))
      .mockReturnValueOnce(asExecaResult(ok("deu certo")));

    const onRetry = vi.fn();
    vi.useFakeTimers();
    const promise = runAgentCommand({
      agent: "claude",
      command: "claude",
      args: ["-p", "x"],
      prompt: "x",
      onRetry,
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.output).toBe("deu certo");
    expect(mockedExeca).toHaveBeenCalledTimes(2);
    expect(result.retries).toHaveLength(1);
    expect(result.retries?.[0]).toMatchObject({ attempt: 1, kind: "nonzero_exit", delayMs: 1000 });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ attempt: 1, maxRetries: 3, delayMs: 1000 });
  });

  it("backoff exponencial simples: delays de 1s, 2s e 4s entre tentativas", async () => {
    mockedExeca
      .mockReturnValueOnce(asExecaResult(failNonZero()))
      .mockReturnValueOnce(asExecaResult(failNonZero()))
      .mockReturnValueOnce(asExecaResult(failNonZero()))
      .mockReturnValueOnce(asExecaResult(ok("ok na quarta")));

    vi.useFakeTimers();
    const promise = runAgentCommand({
      agent: "antigravity",
      command: "agy",
      args: ["-p", "x"],
      prompt: "x",
      maxRetries: 3,
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(mockedExeca).toHaveBeenCalledTimes(4);
    expect(result.retries?.map((r) => r.delayMs)).toEqual([1000, 2000, 4000]);
  });

  it("retryBaseDelayMs customizado muda a base do backoff (ex.: .orquestradorrc pedindo um delay maior)", async () => {
    mockedExeca
      .mockReturnValueOnce(asExecaResult(failNonZero()))
      .mockReturnValueOnce(asExecaResult(failNonZero()))
      .mockReturnValueOnce(asExecaResult(ok("ok na terceira")));

    vi.useFakeTimers();
    const promise = runAgentCommand({
      agent: "antigravity",
      command: "agy",
      args: ["-p", "x"],
      prompt: "x",
      maxRetries: 2,
      retryBaseDelayMs: 3000,
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.retries?.map((r) => r.delayMs)).toEqual([3000, 6000]);
  });

  it("esgota as tentativas e propaga o erro final com o histórico de retries", async () => {
    mockedExeca.mockImplementation(() => asExecaResult(failNonZero("continua falhando")));

    let caught: unknown;
    vi.useFakeTimers();
    const promise = runAgentCommand({
      agent: "claude",
      command: "claude",
      args: ["-p", "x"],
      prompt: "x",
      maxRetries: 2,
    }).catch((error: unknown) => {
      caught = error;
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(mockedExeca).toHaveBeenCalledTimes(3); // 1 tentativa inicial + 2 retries
    expect(caught).toBeInstanceOf(AgentError);
    const error = caught as AgentError;
    expect(error.kind).toBe("nonzero_exit");
    expect(error.retries).toHaveLength(2);
    expect(error.retries.map((r) => r.attempt)).toEqual([1, 2]);
  });

  it("comando não encontrado (ENOENT) não é elegível pra retry — falha direto", async () => {
    const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    mockedExeca.mockImplementation(() => {
      throw enoent;
    });

    const onRetry = vi.fn();
    await expect(
      runAgentCommand({ agent: "claude", command: "claude", args: [], prompt: "x", onRetry }),
    ).rejects.toMatchObject({ kind: "command_not_found" });

    expect(mockedExeca).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("argumento inválido (heurística de stderr) não é elegível pra retry — falha direto", async () => {
    mockedExeca.mockReturnValueOnce(asExecaResult(failNonZero("error: unknown option '--foo'")));

    const onRetry = vi.fn();
    await expect(
      runAgentCommand({ agent: "antigravity", command: "agy", args: ["--foo"], prompt: "x", onRetry }),
    ).rejects.toMatchObject({ kind: "invalid_argument" });

    expect(mockedExeca).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  // Duas chamadas concorrentes, como acontece dentro de runPipelines()
  // (Promise.allSettled) pra duas tarefas de um lote via ";" na TUI. O que
  // está em jogo: o `await sleep(delayMs)` do backoff é um setTimeout — não
  // deveria travar o event loop nem atrasar em nada uma OUTRA chamada que
  // não precisa de retry e já tem tudo que precisa pra resolver.
  it("[timers falsos] o backoff de retry de uma chamada não bloqueia a resolução de uma chamada concorrente", async () => {
    mockedExeca
      .mockReturnValueOnce(asExecaResult(failNonZero())) // tarefa A, 1ª tentativa: falha
      .mockReturnValueOnce(asExecaResult(ok("tarefa B ok"))) // tarefa B: sucesso de cara
      .mockReturnValueOnce(asExecaResult(ok("tarefa A ok na 2ª tentativa")));

    vi.useFakeTimers();
    let taskAResolved = false;
    let taskBResolved = false;

    const taskA = runAgentCommand({ agent: "claude", command: "claude", args: [], prompt: "A" }).then((r) => {
      taskAResolved = true;
      return r;
    });
    const taskB = runAgentCommand({ agent: "antigravity", command: "agy", args: [], prompt: "B" }).then((r) => {
      taskBResolved = true;
      return r;
    });

    // Avança 0ms de tempo falso, mas drena os microtasks pendentes no
    // caminho (é o que `advanceTimersByTimeAsync` faz, diferente da versão
    // síncrona) — dá tempo da tarefa A cair no catch e AGENDAR seu
    // setTimeout de 1000ms, e da tarefa B terminar de verdade, sem avançar
    // o relógio até o ponto em que o timer de A dispararia.
    await vi.advanceTimersByTimeAsync(0);

    expect(taskBResolved).toBe(true);
    expect(taskAResolved).toBe(false); // ainda esperando o backoff de 1s, sem travar B

    await vi.runAllTimersAsync();
    await taskA;

    expect(taskAResolved).toBe(true);
  });

  // Mesma garantia, mas com o relógio de verdade (sem useFakeTimers) — prova
  // que a conclusão não-bloqueante acontece também sob o agendador real do
  // Node, não só sob a simulação de timers do Vitest.
  it(
    "[timers reais] o backoff de retry de uma chamada não atrasa o tempo de parede de uma chamada concorrente",
    async () => {
      mockedExeca
        .mockReturnValueOnce(asExecaResult(failNonZero())) // A: 1ª tentativa falha
        .mockReturnValueOnce(asExecaResult(ok("B ok"))) // B: sucesso de cara
        .mockReturnValueOnce(asExecaResult(ok("A ok na 2ª tentativa")));

      const start = Date.now();
      let bElapsedMs = -1;

      const taskA = runAgentCommand({ agent: "claude", command: "claude", args: [], prompt: "A", maxRetries: 1 });
      const taskB = runAgentCommand({
        agent: "antigravity",
        command: "agy",
        args: [],
        prompt: "B",
        maxRetries: 1,
      }).then((r) => {
        bElapsedMs = Date.now() - start;
        return r;
      });

      const [resultA, resultB] = await Promise.all([taskA, taskB]);
      const totalElapsedMs = Date.now() - start;

      expect(resultA.output).toBe("A ok na 2ª tentativa");
      expect(resultB.output).toBe("B ok");
      // B não precisou de retry — se o backoff de A bloqueasse o event loop,
      // B levaria pelo menos os ~1000ms de A pra resolver. Margem generosa
      // (300ms) só pra não ficar flaky em CI, bem abaixo do delay de A.
      expect(bElapsedMs).toBeLessThan(300);
      // O tempo total fica perto do delay de A sozinho (~1000ms), não da
      // soma de A + B — confirma overlap real, não serialização.
      expect(totalElapsedMs).toBeLessThan(1400);
    },
    10_000,
  );
});
