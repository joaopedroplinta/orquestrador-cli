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
});
