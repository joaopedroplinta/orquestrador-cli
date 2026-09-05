import { describe, expect, it } from "vitest";
import { runAntigravity } from "./antigravity.js";
import { runClaudeCode } from "./claudeCode.js";
import { AGENT_NAMES, AGENT_REGISTRY, isAgentName } from "./registry.js";

describe("AGENT_REGISTRY", () => {
  it("tem exatamente as entradas claude e antigravity", () => {
    expect(Object.keys(AGENT_REGISTRY).sort()).toEqual(["antigravity", "claude"]);
  });

  it("aponta o runner de cada agente pro wrapper de verdade (mesma referência de função)", () => {
    expect(AGENT_REGISTRY.claude.runner).toBe(runClaudeCode);
    expect(AGENT_REGISTRY.antigravity.runner).toBe(runAntigravity);
  });

  it("streamsIncrementally reflete o probe manual documentado no CLAUDE.md", () => {
    expect(AGENT_REGISTRY.claude.streamsIncrementally).toBe(false);
    expect(AGENT_REGISTRY.antigravity.streamsIncrementally).toBe(true);
  });
});

describe("AGENT_NAMES", () => {
  it("é derivado das chaves do registro, não uma lista hardcoded separada", () => {
    expect(AGENT_NAMES.sort()).toEqual(["antigravity", "claude"]);
  });
});

describe("isAgentName", () => {
  it("reconhece os agentes de verdade", () => {
    expect(isAgentName("claude")).toBe(true);
    expect(isAgentName("antigravity")).toBe(true);
  });

  it("rejeita nomes desconhecidos, incluindo variações de caixa", () => {
    expect(isAgentName("foo")).toBe(false);
    expect(isAgentName("Claude")).toBe(false);
    expect(isAgentName("")).toBe(false);
  });
});
