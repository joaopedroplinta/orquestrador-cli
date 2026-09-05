import type { AgentName } from "../types.js";

export type ParsedInput =
  | { kind: "task"; text: string }
  /** 2+ tarefas separadas por ";" na mesma linha — rodam em paralelo via runPipelines. */
  | { kind: "tasks"; texts: string[] }
  | { kind: "exit" }
  | { kind: "history" }
  | { kind: "set-agent"; agent: AgentName | null }
  | { kind: "toggle-auto" }
  | { kind: "error"; message: string };

// Pura e sem I/O de propósito: a TUI (Ink) não tem teste automatizado, mas o
// parsing de slash command sim — mantém a lógica de decisão fora do componente.
export function parseInput(raw: string): ParsedInput {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) {
    const parts = trimmed
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length >= 2) {
      return { kind: "tasks", texts: parts };
    }
    return { kind: "task", text: trimmed };
  }

  const [rawCommand, ...rest] = trimmed.slice(1).split(/\s+/);
  const command = (rawCommand ?? "").toLowerCase();
  const arg = rest.join(" ").toLowerCase();

  switch (command) {
    case "exit":
    case "quit":
      return { kind: "exit" };
    case "history":
      return { kind: "history" };
    case "auto":
      return { kind: "toggle-auto" };
    case "agent":
      if (arg === "claude" || arg === "antigravity") {
        return { kind: "set-agent", agent: arg };
      }
      if (arg === "auto") {
        return { kind: "set-agent", agent: null };
      }
      return {
        kind: "error",
        message: 'Uso: "/agent claude", "/agent antigravity" ou "/agent auto" (volta ao roteamento normal).',
      };
    default:
      return {
        kind: "error",
        message: `Comando desconhecido: "/${command}". Comandos disponíveis: /history, /agent, /auto, /exit, /quit.`,
      };
  }
}

export interface ModeState {
  /** Agente forçado via "/agent claude|antigravity" — null = roteamento normal (planTask/--auto). */
  forcedAgent: AgentName | null;
  /** Equivalente ao --auto do modo CLI: classifica via claude quando planTask vier vazio. */
  autoMode: boolean;
}

export const INITIAL_MODE_STATE: ModeState = { forcedAgent: null, autoMode: false };

// Só "set-agent" e "toggle-auto" alteram o modo; os demais retornam o estado inalterado.
export function applyModeCommand(state: ModeState, action: ParsedInput): ModeState {
  switch (action.kind) {
    case "set-agent":
      return { ...state, forcedAgent: action.agent };
    case "toggle-auto":
      return { ...state, autoMode: !state.autoMode };
    default:
      return state;
  }
}
