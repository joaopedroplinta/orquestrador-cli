import { describe, expect, it } from "vitest";
import {
  agentsForRoles,
  DEFAULT_ENABLED_AGENTS,
  disabledAgents,
  parseAgentNames,
  withAgentsDisabled,
  withAgentsEnabled,
} from "./availability.js";

describe("agentsForRoles", () => {
  it("com todos habilitados, reproduz o mapeamento histórico papel → agente", () => {
    expect(agentsForRoles(["pesquisa"], DEFAULT_ENABLED_AGENTS)).toEqual(["antigravity"]);
    expect(agentsForRoles(["implementacao"], DEFAULT_ENABLED_AGENTS)).toEqual(["claude"]);
    expect(agentsForRoles(["pesquisa", "implementacao"], DEFAULT_ENABLED_AGENTS)).toEqual([
      "antigravity",
      "claude",
    ]);
  });

  it("o papel de um agente desabilitado passa pro próximo da preferência", () => {
    expect(agentsForRoles(["pesquisa"], ["claude", "codex"])).toEqual(["claude"]);
    expect(agentsForRoles(["implementacao"], ["antigravity", "codex"])).toEqual(["codex"]);
  });

  it("dois papéis com dois agentes habilitados continuam sendo um handoff entre agentes distintos", () => {
    expect(agentsForRoles(["pesquisa", "implementacao"], ["claude", "codex"])).toEqual(["claude", "codex"]);
  });

  it("com um único agente habilitado, os dois papéis colapsam numa etapa só", () => {
    expect(agentsForRoles(["pesquisa", "implementacao"], ["codex"])).toEqual(["codex"]);
  });

  it("sem nenhum agente habilitado não inventa etapa nenhuma", () => {
    expect(agentsForRoles(["pesquisa", "implementacao"], [])).toEqual([]);
  });
});

describe("ligar/desligar agentes", () => {
  it("desabilitar remove só o pedido e mantém a ordem canônica do registro", () => {
    expect(withAgentsDisabled(DEFAULT_ENABLED_AGENTS, ["antigravity"])).toEqual(["claude", "codex"]);
  });

  it("desabilitar quem já está fora é no-op, não erro", () => {
    const semAntigravity = withAgentsDisabled(DEFAULT_ENABLED_AGENTS, ["antigravity"]);
    expect(withAgentsDisabled(semAntigravity, ["antigravity"])).toEqual(semAntigravity);
  });

  it("habilitar normaliza pra ordem do registro, seja qual for a ordem de entrada", () => {
    expect(withAgentsEnabled(["codex"], ["antigravity", "claude"])).toEqual([
      "claude",
      "antigravity",
      "codex",
    ]);
  });

  it("habilitar de novo quem já está dentro não duplica", () => {
    expect(withAgentsEnabled(["claude"], ["claude"])).toEqual(["claude"]);
  });

  it("disabledAgents é o complemento exato dos habilitados", () => {
    expect(disabledAgents(["claude", "codex"])).toEqual(["antigravity"]);
    expect(disabledAgents(DEFAULT_ENABLED_AGENTS)).toEqual([]);
  });
});

describe("parseAgentNames", () => {
  it("aceita lista separada por vírgula, tolerando espaço e caixa", () => {
    expect(parseAgentNames(" Claude , CODEX ")).toEqual({ agents: ["claude", "codex"] });
  });

  it("normaliza pra ordem do registro e deduplica", () => {
    expect(parseAgentNames("codex,claude,codex")).toEqual({ agents: ["claude", "codex"] });
  });

  it("devolve erro (não lança) pra nome desconhecido ou lista vazia", () => {
    const desconhecido = parseAgentNames("banana");
    expect("error" in desconhecido && desconhecido.error).toContain("banana");
    expect("error" in parseAgentNames("")).toBe(true);
    expect("error" in parseAgentNames(" , ")).toBe(true);
  });
});
