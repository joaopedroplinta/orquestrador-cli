import { describe, expect, it } from "vitest";
import { applyModeCommand, INITIAL_MODE_STATE, parseInput } from "./commands.js";

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

  it("/agent claude e /agent antigravity forçam o agente", () => {
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

  it("/routing com argumento inválido ou ausente retorna erro, não trava nem vira tarefa", () => {
    expect(parseInput("/routing banana").kind).toBe("error");
    expect(parseInput("/routing").kind).toBe("error");
  });

  it("/mascot vira toggle-mascot (sem argumento, é só um liga/desliga)", () => {
    expect(parseInput("/mascot")).toEqual({ kind: "toggle-mascot" });
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

describe("applyModeCommand", () => {
  it("/agent claude força o agente no estado", () => {
    const next = applyModeCommand(INITIAL_MODE_STATE, { kind: "set-agent", agent: "claude" });
    expect(next).toEqual({ forcedAgent: "claude", autoMode: false, routing: "keyword", mascotEnabled: true });
  });

  it("/agent auto reseta forcedAgent pra null, mantendo o resto do estado", () => {
    const forced: import("./commands.js").ModeState = {
      forcedAgent: "claude",
      autoMode: true,
      routing: "keyword",
      mascotEnabled: true,
    };
    const next = applyModeCommand(forced, { kind: "set-agent", agent: null });
    expect(next).toEqual({ forcedAgent: null, autoMode: true, routing: "keyword", mascotEnabled: true });
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
    expect(next).toEqual({ forcedAgent: null, autoMode: false, routing: "classify", mascotEnabled: true });
  });

  it("/mascot alterna mascotEnabled: ligado -> desligado -> ligado", () => {
    let state = INITIAL_MODE_STATE;
    state = applyModeCommand(state, { kind: "toggle-mascot" });
    expect(state.mascotEnabled).toBe(false);
    state = applyModeCommand(state, { kind: "toggle-mascot" });
    expect(state.mascotEnabled).toBe(true);
  });

  it("comandos que não afetam o modo (exit, history, error, task) deixam o estado inalterado", () => {
    expect(applyModeCommand(INITIAL_MODE_STATE, { kind: "exit" })).toEqual(INITIAL_MODE_STATE);
    expect(applyModeCommand(INITIAL_MODE_STATE, { kind: "history" })).toEqual(INITIAL_MODE_STATE);
    expect(applyModeCommand(INITIAL_MODE_STATE, { kind: "error", message: "x" })).toEqual(INITIAL_MODE_STATE);
    expect(applyModeCommand(INITIAL_MODE_STATE, { kind: "task", text: "x" })).toEqual(INITIAL_MODE_STATE);
  });

  it("forçar agente, ligar --auto, trocar o roteamento e desligar o mascote são independentes entre si", () => {
    let state = applyModeCommand(INITIAL_MODE_STATE, { kind: "toggle-auto" });
    state = applyModeCommand(state, { kind: "set-agent", agent: "claude" });
    state = applyModeCommand(state, { kind: "set-routing", routing: "classify" });
    state = applyModeCommand(state, { kind: "toggle-mascot" });
    expect(state).toEqual({ forcedAgent: "claude", autoMode: true, routing: "classify", mascotEnabled: false });
  });
});
