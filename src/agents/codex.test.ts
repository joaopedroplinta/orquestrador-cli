import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCodex } from "./codex.js";

vi.mock("execa", () => ({ execa: vi.fn() }));
const mockedExeca = vi.mocked(execa);
const message = (text: string) => ({ type: "item.completed", item: { type: "agent_message", text } });
const completed = { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 80 } };
function respond(events: unknown[], overrides = {}) {
  mockedExeca.mockReturnValueOnce(Promise.resolve({
    exitCode: 0, timedOut: false, failed: false, stderr: "",
    stdout: events.map((event) => JSON.stringify(event)).join("\r\n"), ...overrides,
  }) as unknown as ReturnType<typeof execa>);
}
afterEach(() => vi.resetAllMocks());

describe("runCodex", () => {
  it("envia contexto e prompt via stdin, preservando texto que parece flag", async () => {
    respond([message("feito"), completed]);
    const onChunk = vi.fn();
    const result = await runCodex({ prompt: "--help", context: "pesquisa anterior", onChunk, timeoutMs: 5000 });
    expect(mockedExeca).toHaveBeenCalledWith("codex",
      ["exec", "--json", "--sandbox", "workspace-write", "-"],
      { input: "pesquisa anterior\n\n--help", timeout: 5000, reject: false });
    expect(result.prompt).toBe("pesquisa anterior\n\n--help");
    expect(result.output).toBe("feito");
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("extrai somente a última mensagem e tokens reais, sem inventar custo", async () => {
    respond([
      { type: "thread.started", thread_id: "thread-1" },
      message("vou analisar"),
      { type: "item.completed", item: { type: "reasoning", text: "interno" } },
      { type: "item.completed", item: { type: "command_execution", aggregated_output: "log" } },
      { type: "future.event" }, message("implementado"), completed,
    ]);
    const result = await runCodex({ prompt: "implementar" });
    expect(result.output).toBe("implementado");
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 });
    expect(result.usage?.costUsd).toBeUndefined();
  });

  it.each([
    [message("incompleto")],
    [completed],
    [message(""), completed],
    [null],
    [{ type: "turn.failed", error: { message: "limite atingido" } }],
  ])("não transforma resposta incompleta/falha em sucesso (%j)", async (...events) => {
    respond(events);
    await expect(runCodex({ prompt: "teste" })).rejects.toMatchObject({ agent: "codex", kind: "nonzero_exit" });
  });

  it("rejeita JSON inválido", async () => {
    respond([], { stdout: "não é JSON" });
    await expect(runCodex({ prompt: "teste" })).rejects.toThrow("JSONL inválida");
  });

  it("aceita sucesso sem usage e ignora contagens inválidas", async () => {
    respond([message("ok"), { type: "turn.completed" }]);
    expect((await runCodex({ prompt: "teste" })).usage).toBeUndefined();
    respond([message("ok"), { type: "turn.completed", usage: { input_tokens: -1, output_tokens: "20" } }]);
    expect((await runCodex({ prompt: "teste" })).usage?.inputTokens).toBeUndefined();
  });

  it("propaga falha do processo e retry com o prompt original", async () => {
    respond([], { exitCode: 1, failed: true, stderr: "network unavailable" });
    respond([message("ok"), completed]);
    const onRetry = vi.fn();
    const result = await runCodex({ prompt: "teste", maxRetries: 1, retryBaseDelayMs: 0, onRetry });
    expect(result.retries).toHaveLength(1);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(mockedExeca).toHaveBeenCalledTimes(2);
  });
});
