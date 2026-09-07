import { describe, expect, it } from "vitest";
import {
  applyModeCommand,
  getCommandSuggestions,
  INITIAL_MODE_STATE,
  parseInput,
  SLASH_COMMANDS,
  toggleAgents,
} from "./commands.js";

describe("parseInput", () => {
  it("texto sem barra vira uma tarefa", () => {
    expect(parseInput("pesquisar node")).toEqual({ kind: "task", text: "pesquisar node" });
  });

  it("2+ tarefas separadas por ; viram kind: tasks, aparadas", () => {
    expect(parseInput("pesquisar node ; implementar endpoint")).toEqual({
      kind: "tasks",
      texts: ["pesquisar node", "implementar endpoint"],
    });
  });

  it("3 tarefas separadas por ; viram kind: tasks com os 3 textos", () => {
    expect(parseInput("a; b; c")).toEqual({ kind: "tasks", texts: ["a", "b", "c"] });
  });

  it("; solto (só uma parte não-vazia) cai de volta pro kind: task original", () => {
    expect(parseInput("pesquisar node;")).toEqual({ kind: "task", text: "pesquisar node;" });
    expect(parseInput(";")).toEqual({ kind: "task", text: ";" });
  });

  it("/exit e /quit viram exit", () => {
    expect(parseInput("/exit")).toEqual({ kind: "exit" });
    expect(parseInput("/quit")).toEqual({ kind: "exit" });
  });

  it("/history vira history", () => {
    expect(parseInput("/history")).toEqual({ kind: "history" });
  });

  it("/team preserva o texto da tarefa e exige uma tarefa", () => {
    expect(parseInput("/team Implementar Login com JWT")).toEqual({ kind: "team", task: "Implementar Login com JWT" });
    expect(parseInput("/team").kind).toBe("error");
  });

  it("/team aceita agentes e concorrência antes da tarefa", () => {
    expect(parseInput("/team --agents codex,claude --concurrency 2 implementar Login")).toEqual({
      kind: "team", task: "implementar Login", agents: ["codex", "claude"], concurrency: 2,
    });
    expect(parseInput("/team --agents codex,codex implementar").kind).toBe("error");
    expect(parseInput("/team --concurrency 0 implementar").kind).toBe("error");
  });

  it("/help vira help", () => {
    expect(parseInput("/help")).toEqual({ kind: "help" });
  });

  it("/status e /doctor viram status", () => {
    expect(parseInput("/status")).toEqual({ kind: "status" });
    expect(parseInput("/doctor")).toEqual({ kind: "status" });
  });

  it("/clear vira clear", () => {
    expect(parseInput("/clear")).toEqual({ kind: "clear" });
  });

  it("/agent claude e /agent antigravity forçam o agente", () => {
    expect(parseInput("/agent codex")).toEqual({ kind: "set-agent", agent: "codex" });
    expect(parseInput("/agent claude")).toEqual({ kind: "set-agent", agent: "claude" });
    expect(parseInput("/agent antigravity")).toEqual({ kind: "set-agent", agent: "antigravity" });
  });

  it("/agent auto reseta pro roteamento normal (agent: null)", () => {
    expect(parseInput("/agent auto")).toEqual({ kind: "set-agent", agent: null });
  });

  it("/agent com argumento inválido ou ausente retorna erro, não trava nem vira tarefa", () => {
    expect(parseInput("/agent banana").kind).toBe("error");
    expect(parseInput("/agent").kind).toBe("error");
  });

  it("/auto vira toggle-auto", () => {
    expect(parseInput("/auto")).toEqual({ kind: "toggle-auto" });
  });

  it("/routing keyword e /routing classify setam a estratégia", () => {
    expect(parseInput("/routing keyword")).toEqual({ kind: "set-routing", routing: "keyword" });
    expect(parseInput("/routing classify")).toEqual({ kind: "set-routing", routing: "classify" });
  });

  it("/agents sozinho lista, e on/off aceitam um ou mais nomes", () => {
    expect(parseInput("/agents")).toEqual({ kind: "list-agents" });
    expect(parseInput("/agents off antigravity")).toEqual({
      kind: "toggle-agents", agents: ["antigravity"], enabled: false,
    });
    expect(parseInput("/agents on antigravity")).toEqual({
      kind: "toggle-agents", agents: ["antigravity"], enabled: true,
    });
    expect(parseInput("/agents off antigravity,codex")).toEqual({
      kind: "toggle-agents", agents: ["antigravity", "codex"], enabled: false,
    });
  });

  it("/agents com verbo ou nome inválido retorna erro, nunca vira tarefa", () => {
    expect(parseInput("/agents antigravity").kind).toBe("error");
    expect(parseInput("/agents off banana").kind).toBe("error");
    expect(parseInput("/agents off").kind).toBe("error");
  });

  it("/routing com argumento inválido ou ausente retorna erro, não trava nem vira tarefa", () => {
    expect(parseInput("/routing banana").kind).toBe("error");
    expect(parseInput("/routing").kind).toBe("error");
  });

  it("comando desconhecido retorna erro amigável (nunca vira tarefa nem lança exceção)", () => {
    const result = parseInput("/foo");
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("/foo");
    }
  });

  it("é case-insensitive pro nome do comando e do argumento do agente/roteamento", () => {
    expect(parseInput("/AGENT CLAUDE")).toEqual({ kind: "set-agent", agent: "claude" });
    expect(parseInput("/HISTORY")).toEqual({ kind: "history" });
    expect(parseInput("/ROUTING CLASSIFY")).toEqual({ kind: "set-routing", routing: "classify" });
  });
});

describe("getCommandSuggestions", () => {
  it("retorna lista vazia para texto sem barra inicial", () => {
    expect(getCommandSuggestions("pesquisar")).toEqual([]);
    expect(getCommandSuggestions("")).toEqual([]);
  });

  it("retorna todos os comandos visíveis quando apenas '/' é digitado", () => {
    const suggestions = getCommandSuggestions("/");
    const visibleCount = SLASH_COMMANDS.filter((c) => !c.hidden).length;
    expect(suggestions.length).toBe(visibleCount);
  });

  it("retorna sugestões filtradas por prefixo", () => {
    const suggestions = getCommandSuggestions("/he");
    expect(suggestions.some((c) => c.name === "help")).toBe(true);
    expect(suggestions.every((c) => c.name.startsWith("he") || c.aliases?.some((a) => a.startsWith("he")))).toBe(true);
  });

  it("retorna vazio após espaço", () => {
    expect(getCommandSuggestions("/agent ")).toEqual([]);
  });
});

describe("applyModeCommand", () => {
  it("/agent claude força o agente no estado", () => {
    const next = applyModeCommand(INITIAL_MODE_STATE, { kind: "set-agent", agent: "claude" });
    expect(next).toEqual({ ...INITIAL_MODE_STATE, forcedAgent: "claude" });
  });

  it("/agent auto reseta forcedAgent pra null, mantendo o resto do estado", () => {
    const forced: import("./commands.js").ModeState = {
      ...INITIAL_MODE_STATE,
      forcedAgent: "claude",
      autoMode: true,
    };
    const next = applyModeCommand(forced, { kind: "set-agent", agent: null });
    expect(next).toEqual({ ...INITIAL_MODE_STATE, forcedAgent: null, autoMode: true });
  });

  it("/auto alterna autoMode: desligado -> ligado -> desligado", () => {
    let state = INITIAL_MODE_STATE;
    state = applyModeCommand(state, { kind: "toggle-auto" });
    expect(state.autoMode).toBe(true);
    state = applyModeCommand(state, { kind: "toggle-auto" });
    expect(state.autoMode).toBe(false);
  });

  it("/routing classify muda a estratégia, mantendo o resto do estado intacto", () => {
    const next = applyModeCommand(INITIAL_MODE_STATE, { kind: "set-routing", routing: "classify" });
    expect(next).toEqual({ ...INITIAL_MODE_STATE, routing: "classify" });
  });

  it("comandos que não afetam o modo (exit, history, error, task, help, status, clear) deixam o estado inalterado", () => {
    expect(applyModeCommand(INITIAL_MODE_STATE, { kind: "exit" })).toEqual(INITIAL_MODE_STATE);
    expect(applyModeCommand(INITIAL_MODE_STATE, { kind: "history" })).toEqual(INITIAL_MODE_STATE);
    expect(applyModeCommand(INITIAL_MODE_STATE, { kind: "help" })).toEqual(INITIAL_MODE_STATE);
    expect(applyModeCommand(INITIAL_MODE_STATE, { kind: "status" })).toEqual(INITIAL_MODE_STATE);
    expect(applyModeCommand(INITIAL_MODE_STATE, { kind: "clear" })).toEqual(INITIAL_MODE_STATE);
    expect(applyModeCommand(INITIAL_MODE_STATE, { kind: "error", message: "x" })).toEqual(INITIAL_MODE_STATE);
    expect(applyModeCommand(INITIAL_MODE_STATE, { kind: "task", text: "x" })).toEqual(INITIAL_MODE_STATE);
  });

  it("desligar um agente tira ele de enabledAgents sem mexer no resto do modo", () => {
    const { mode, error } = toggleAgents(INITIAL_MODE_STATE, ["antigravity"], false);
    expect(error).toBeUndefined();
    expect(mode.enabledAgents).toEqual(["claude", "codex"]);
    expect(mode.routing).toBe(INITIAL_MODE_STATE.routing);
  });

  it("religar devolve o agente na ordem canônica do registro, não na ordem de digitação", () => {
    const off = toggleAgents(INITIAL_MODE_STATE, ["claude", "antigravity"], false).mode;
    expect(off.enabledAgents).toEqual(["codex"]);
    const on = toggleAgents(off, ["antigravity", "claude"], true).mode;
    expect(on.enabledAgents).toEqual(["claude", "antigravity", "codex"]);
  });

  it("desligar o último agente é recusado com erro, e o estado fica intacto", () => {
    const restam = toggleAgents(INITIAL_MODE_STATE, ["antigravity", "codex"], false).mode;
    const { mode, error } = toggleAgents(restam, ["claude"], false);
    expect(error).toContain("sem nenhum agente");
    expect(mode).toBe(restam);
  });

  it("desligar o agente que estava forçado volta pro roteamento automático", () => {
    const forced = applyModeCommand(INITIAL_MODE_STATE, { kind: "set-agent", agent: "antigravity" });
    const { mode } = toggleAgents(forced, ["antigravity"], false);
    expect(mode.forcedAgent).toBeNull();
    expect(mode.enabledAgents).toEqual(["claude", "codex"]);
  });

  it("desligar um agente qualquer NÃO mexe num agente forçado diferente", () => {
    const forced = applyModeCommand(INITIAL_MODE_STATE, { kind: "set-agent", agent: "claude" });
    const { mode } = toggleAgents(forced, ["antigravity"], false);
    expect(mode.forcedAgent).toBe("claude");
  });

  it("forçar agente, ligar --auto e trocar o roteamento são independentes entre si", () => {
    let state = applyModeCommand(INITIAL_MODE_STATE, { kind: "toggle-auto" });
    state = applyModeCommand(state, { kind: "set-agent", agent: "claude" });
    state = applyModeCommand(state, { kind: "set-routing", routing: "classify" });
    expect(state).toEqual({ ...INITIAL_MODE_STATE, forcedAgent: "claude", autoMode: true, routing: "classify" });
  });
});
