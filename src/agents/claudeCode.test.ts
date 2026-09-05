import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runClaudeCode } from "./claudeCode.js";

vi.mock("execa", () => ({ execa: vi.fn() }));

const mockedExeca = vi.mocked(execa);

function execaResult(stdout: string) {
  return Promise.resolve({ exitCode: 0, timedOut: false, failed: false, stdout, stderr: "" }) as unknown as ReturnType<
    typeof execa
  >;
}

describe("runClaudeCode — envelope --output-format json", () => {
  afterEach(() => {
    mockedExeca.mockReset();
  });

  it("chama o claude com --output-format json", async () => {
    mockedExeca.mockReturnValueOnce(execaResult(JSON.stringify({ result: "ok" })));

    await runClaudeCode({ prompt: "oi" });

    expect(mockedExeca).toHaveBeenCalledWith(
      "claude",
      ["-p", "oi", "--output-format", "json"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("extrai o texto de resposta de `.result` e o usage completo (tokens + custo real em USD)", async () => {
    const envelope = {
      result: "recursão é quando uma função chama a si mesma",
      total_cost_usd: 0.0890346,
      usage: {
        input_tokens: 2,
        output_tokens: 4,
        cache_read_input_tokens: 16652,
        cache_creation_input_tokens: 13838,
        output_tokens_details: { thinking_tokens: 7 },
      },
    };
    mockedExeca.mockReturnValueOnce(execaResult(JSON.stringify(envelope)));

    const result = await runClaudeCode({ prompt: "explica recursão" });

    expect(result.output).toBe("recursão é quando uma função chama a si mesma");
    expect(result.usage).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheReadTokens: 16652,
      cacheCreationTokens: 13838,
      thinkingTokens: 7,
      costUsd: 0.0890346,
    });
  });

  it("envelope sem usage/custo (campos ausentes) não quebra — usage vem com os campos faltando undefined", async () => {
    mockedExeca.mockReturnValueOnce(execaResult(JSON.stringify({ result: "ok" })));

    const result = await runClaudeCode({ prompt: "oi" });

    expect(result.output).toBe("ok");
    expect(result.usage).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
      thinkingTokens: undefined,
      costUsd: undefined,
    });
  });

  it("stdout que não é JSON válido cai pro texto bruto, sem usage e sem lançar exceção", async () => {
    mockedExeca.mockReturnValueOnce(execaResult("não é json nenhum"));

    const result = await runClaudeCode({ prompt: "oi" });

    expect(result.output).toBe("não é json nenhum");
    expect(result.usage).toBeUndefined();
  });

  it('JSON válido mas sem campo "result" (formato inesperado) também cai pro texto bruto', async () => {
    const stdout = JSON.stringify({ usage: { input_tokens: 1 } }); // sem "result"
    mockedExeca.mockReturnValueOnce(execaResult(stdout));

    const result = await runClaudeCode({ prompt: "oi" });

    expect(result.output).toBe(stdout);
    expect(result.usage).toBeUndefined();
  });
});
