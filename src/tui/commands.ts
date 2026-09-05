import { isAgentName } from "../agents/registry.js";
import type { AgentName, RoutingStrategy } from "../types.js";

export type ParsedInput =
  | { kind: "task"; text: string }
  /** 2+ tarefas separadas por ";" na mesma linha — rodam em paralelo via runPipelines. */
  | { kind: "tasks"; texts: string[] }
  | { kind: "exit" }
  | { kind: "history" }
  | { kind: "set-agent"; agent: AgentName | null }
  | { kind: "toggle-auto" }
  | { kind: "set-routing"; routing: RoutingStrategy }
  | { kind: "toggle-mascot" }
  | { kind: "error"; message: string };

function isRoutingStrategy(value: string): value is RoutingStrategy {
  return value === "keyword" || value === "classify";
}

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
      if (isAgentName(arg)) {
        return { kind: "set-agent", agent: arg };
      }
      if (arg === "auto") {
        return { kind: "set-agent", agent: null };
      }
      return {
        kind: "error",
        message: 'Uso: "/agent claude", "/agent antigravity" ou "/agent auto" (volta ao roteamento normal).',
      };
    case "routing":
      if (isRoutingStrategy(arg)) {
        return { kind: "set-routing", routing: arg };
      }
      return {
        kind: "error",
        message: 'Uso: "/routing keyword" ou "/routing classify".',
      };
    case "mascot":
      return { kind: "toggle-mascot" };
    default:
      return {
        kind: "error",
        message: `Comando desconhecido: "/${command}". Comandos disponíveis: /history, /agent, /auto, /routing, /mascot, /exit, /quit.`,
      };
  }
}

export interface ModeState {
  /** Agente forçado via "/agent claude|antigravity" — null = roteamento normal (planTask/--auto). */
  forcedAgent: AgentName | null;
  /** Equivalente ao --auto do modo CLI: classifica via claude quando planTask vier vazio. Sem efeito quando routing="classify". */
  autoMode: boolean;
  /** Equivalente ao --routing do modo CLI — padrão "keyword". */
  routing: RoutingStrategy;
  /** Liga/desliga o mascote (banner, spinner e reações). Padrão true; --no-mascot seta o valor inicial. */
  mascotEnabled: boolean;
}

export const INITIAL_MODE_STATE: ModeState = {
  forcedAgent: null,
  autoMode: false,
  routing: "keyword",
  mascotEnabled: true,
};

// Só "set-agent", "toggle-auto", "set-routing" e "toggle-mascot" alteram o modo; os demais retornam o estado inalterado.
export function applyModeCommand(state: ModeState, action: ParsedInput): ModeState {
  switch (action.kind) {
    case "set-agent":
      return { ...state, forcedAgent: action.agent };
    case "toggle-auto":
      return { ...state, autoMode: !state.autoMode };
    case "set-routing":
      return { ...state, routing: action.routing };
    case "toggle-mascot":
      return { ...state, mascotEnabled: !state.mascotEnabled };
    default:
      return state;
  }
}
