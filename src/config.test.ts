import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProjectConfig, parseOrquestradorConfig, resolveConfigValue } from "./config.js";

describe("parseOrquestradorConfig", () => {
  it("aceita um config completo e válido", () => {
    const raw = JSON.stringify({
      agent: "claude",
      routing: "classify",
      auto: true,
      maxRetries: 5,
      retryBaseDelayMs: 2000,
    });

    const { config, warnings } = parseOrquestradorConfig(raw);

    expect(warnings).toEqual([]);
    expect(config).toEqual({
      agent: "claude",
      routing: "classify",
      auto: true,
      maxRetries: 5,
      retryBaseDelayMs: 2000,
    });
  });

  it("objeto vazio é válido — nenhum campo obrigatório", () => {
    expect(parseOrquestradorConfig("{}")).toEqual({ config: {}, warnings: [] });
  });

  it("JSON inválido ignora o arquivo inteiro, com um aviso claro", () => {
    const { config, warnings } = parseOrquestradorConfig("{ isso não é json");
    expect(config).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/JSON inválido/);
  });

  it("JSON que não é um objeto (array, string, número) ignora o arquivo inteiro", () => {
    expect(parseOrquestradorConfig("[1, 2, 3]").config).toEqual({});
    expect(parseOrquestradorConfig('"uma string"').config).toEqual({});
    expect(parseOrquestradorConfig("42").config).toEqual({});
  });

  it('"agent" inválido é descartado (não é "claude"/"antigravity"), mas outros campos válidos continuam', () => {
    const { config, warnings } = parseOrquestradorConfig(JSON.stringify({ agent: "gpt-5", routing: "classify" }));
    expect(config).toEqual({ routing: "classify" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/"agent"/);
  });

  it('"routing" inválido é descartado', () => {
    const { config, warnings } = parseOrquestradorConfig(JSON.stringify({ routing: "aleatorio" }));
    expect(config).toEqual({});
    expect(warnings[0]).toMatch(/"routing"/);
  });

  it('"maxRetries" negativo ou não-inteiro é descartado', () => {
    expect(parseOrquestradorConfig(JSON.stringify({ maxRetries: -1 })).config).toEqual({});
    expect(parseOrquestradorConfig(JSON.stringify({ maxRetries: 2.5 })).config).toEqual({});
    expect(parseOrquestradorConfig(JSON.stringify({ maxRetries: "5" })).config).toEqual({});
    expect(parseOrquestradorConfig(JSON.stringify({ maxRetries: 0 })).config).toEqual({ maxRetries: 0 }); // 0 é válido
  });

  it('"retryBaseDelayMs" zero ou negativo é descartado (backoff de 0ms não faz sentido)', () => {
    expect(parseOrquestradorConfig(JSON.stringify({ retryBaseDelayMs: 0 })).config).toEqual({});
    expect(parseOrquestradorConfig(JSON.stringify({ retryBaseDelayMs: -100 })).config).toEqual({});
  });

  it('"auto" não-booleano é descartado', () => {
    expect(parseOrquestradorConfig(JSON.stringify({ auto: 1 })).config).toEqual({});
  });

  it("múltiplos campos inválidos geram um aviso por campo, não um só genérico", () => {
    const { warnings } = parseOrquestradorConfig(JSON.stringify({ agent: "x", routing: "y" }));
    expect(warnings).toHaveLength(2);
  });
});

describe("resolveConfigValue", () => {
  it("valor de CLI tem prioridade quando presente", () => {
    expect(resolveConfigValue("claude", "antigravity")).toBe("claude");
  });

  it("cai pro valor do projeto quando o de CLI está ausente", () => {
    expect(resolveConfigValue(undefined, "antigravity")).toBe("antigravity");
  });

  it("undefined nos dois níveis continua undefined (quem chama aplica o default global)", () => {
    expect(resolveConfigValue(undefined, undefined)).toBeUndefined();
  });
});

describe("discoverProjectConfig", () => {
  const tmpRoot = join(tmpdir(), `orquestrador-config-test-${randomUUID()}`);

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("acha o .orquestradorrc no próprio diretório de partida", () => {
    mkdirSync(tmpRoot, { recursive: true });
    writeFileSync(join(tmpRoot, ".orquestradorrc"), JSON.stringify({ agent: "claude" }));

    const result = discoverProjectConfig(tmpRoot);

    expect(result?.dir).toBe(tmpRoot);
    expect(result?.config).toEqual({ agent: "claude" });
    expect(result?.warnings).toEqual([]);
  });

  it("sobe diretórios até achar o .orquestradorrc mais próximo (mesma ideia do CLAUDE.md do Claude Code)", () => {
    const nested = join(tmpRoot, "src", "sub", "mais-fundo");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(tmpRoot, ".orquestradorrc"), JSON.stringify({ routing: "classify" }));

    const result = discoverProjectConfig(nested);

    expect(result?.dir).toBe(tmpRoot);
    expect(result?.config).toEqual({ routing: "classify" });
  });

  it("o .orquestradorrc mais próximo do cwd vence sobre um mais acima (não faz merge dos dois níveis)", () => {
    const nested = join(tmpRoot, "sub");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(tmpRoot, ".orquestradorrc"), JSON.stringify({ agent: "antigravity" }));
    writeFileSync(join(nested, ".orquestradorrc"), JSON.stringify({ agent: "claude" }));

    const result = discoverProjectConfig(nested);

    expect(result?.dir).toBe(nested);
    expect(result?.config).toEqual({ agent: "claude" });
  });

  it("devolve undefined quando não existe nenhum .orquestradorrc subindo até a raiz", () => {
    mkdirSync(tmpRoot, { recursive: true });
    // tmpRoot não tem .orquestradorrc, e nada acima dele (fora da árvore de
    // teste) deveria ter — se algum dia isso ficar flaky por um .orquestradorrc
    // de verdade em /tmp ou acima, é um sinal de vazamento de outro teste.
    expect(discoverProjectConfig(tmpRoot)).toBeUndefined();
  });

  it("repassa os avisos de parsing (arquivo achado, mas com campo inválido)", () => {
    mkdirSync(tmpRoot, { recursive: true });
    writeFileSync(join(tmpRoot, ".orquestradorrc"), JSON.stringify({ agent: "gpt-5" }));

    const result = discoverProjectConfig(tmpRoot);

    expect(result?.config).toEqual({});
    expect(result?.warnings).toHaveLength(1);
  });
});

it("aceita Codex como agente padrão do projeto", () => {
  expect(parseOrquestradorConfig('{"agent":"codex"}')).toEqual({ config: { agent: "codex" }, warnings: [] });
});
