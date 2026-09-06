import { isAgentName } from "../agents/registry.js";
import type { AgentName, RoutingStrategy } from "../types.js";

export interface SlashCommandDef {
  name: string;
  aliases?: string[];
  synopsis: string;
  description: string;
  category: "Agente e Roteamento" | "Sessão e Utilidades" | "Ajuda e Diagnóstico";
  hidden?: boolean;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    name: "help",
    synopsis: "/help",
    description: "Exibe a lista completa de comandos disponíveis e atalhos",
    category: "Ajuda e Diagnóstico",
  },
  {
    name: "status",
    aliases: ["doctor"],
    synopsis: "/status",
    description: "Verifica a saúde dos CLIs (claude, agy, codex), Git, Node e SQLite",
    category: "Ajuda e Diagnóstico",
  },
  {
    name: "summary",
    aliases: ["stats", "cost"],
    synopsis: "/summary",
    description: "Exibe o resumo consolidado de tarefas, tempo e custos da sessão",
    category: "Sessão e Utilidades",
  },
  {
    name: "export",
    synopsis: "/export [md|json]",
    description: "Exporta as execuções da sessão para um arquivo Markdown ou JSON",
    category: "Sessão e Utilidades",
  },
  {
    name: "history",
    synopsis: "/history",
    description: "Lista o histórico das execuções passadas",
    category: "Sessão e Utilidades",
  },
  {
    name: "team",
    synopsis: "/team [opções] <tarefa>",
    description: "Planeja uma equipe; aceita --agents e --concurrency antes da tarefa",
    category: "Agente e Roteamento",
  },
  {
    name: "clear",
    synopsis: "/clear",
    description: "Limpa a tela do terminal e reinicia a exibição",
    category: "Sessão e Utilidades",
  },
  {
    name: "agent",
    synopsis: "/agent <claude|antigravity|codex|auto>",
    description: "Força o uso de um agente ou retorna ao modo automático",
    category: "Agente e Roteamento",
  },
  {
    name: "routing",
    synopsis: "/routing <keyword|classify>",
    description: "Define a estratégia de roteamento das tarefas",
    category: "Agente e Roteamento",
  },
  {
    name: "auto",
    synopsis: "/auto",
    description: "Alterna a classificação automática via Claude quando sem palavra-chave",
    category: "Agente e Roteamento",
  },
  {
    name: "exit",
    aliases: ["quit"],
    synopsis: "/exit",
    description: "Encerra o orquestrador (Ctrl+C também sai)",
    category: "Sessão e Utilidades",
  },
];

export function getCommandSuggestions(input: string): SlashCommandDef[] {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return [];

  // Se já digitou espaço, o comando já foi escolhido
  if (trimmed.includes(" ")) return [];

  const prefix = trimmed.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((cmd) => {
    if (cmd.hidden && cmd.name !== prefix) return false;
    if (cmd.name.toLowerCase().startsWith(prefix)) return true;
    return cmd.aliases?.some((alias) => alias.toLowerCase().startsWith(prefix)) ?? false;
  });
}

export type ParsedInput =
  | { kind: "task"; text: string }
  /** 2+ tarefas separadas por ";" na mesma linha — rodam em paralelo via runPipelines. */
  | { kind: "tasks"; texts: string[] }
  | { kind: "team"; task: string; agents?: AgentName[]; concurrency?: number }
  | { kind: "exit" }
  | { kind: "history" }
  | { kind: "status" }
  | { kind: "summary" }
  | { kind: "export"; format: "markdown" | "json" }
  | { kind: "clear" }
  | { kind: "help" }
  | { kind: "set-agent"; agent: AgentName | null }
  | { kind: "toggle-auto" }
  | { kind: "set-routing"; routing: RoutingStrategy }
  | { kind: "error"; message: string };

function isRoutingStrategy(value: string): value is RoutingStrategy {
  return value === "keyword" || value === "classify";
}

function parseTeamCommand(rawArg: string): Extract<ParsedInput, { kind: "team" | "error" }> {
  const words = rawArg.split(/\s+/).filter(Boolean);
  let agents: AgentName[] | undefined;
  let concurrency: number | undefined;
  while (words[0]?.startsWith("--")) {
    const option = words.shift();
    const value = words.shift();
    if (!value) return { kind: "error", message: `A opção ${option} precisa de um valor.` };
    if (option === "--agents") {
      const parsed = value.split(",").map((agent) => agent.trim().toLowerCase());
      if (!parsed.length || !parsed.every(isAgentName) || new Set(parsed).size !== parsed.length) {
        return { kind: "error", message: "Use --agents claude,codex,antigravity (ou um subconjunto sem repetição)." };
      }
      agents = parsed;
      continue;
    }
    if (option === "--concurrency") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 12) {
        return { kind: "error", message: "Use --concurrency com um inteiro entre 1 e 12." };
      }
      concurrency = parsed;
      continue;
    }
    return { kind: "error", message: `Opção de /team desconhecida: ${option}. Use --agents ou --concurrency.` };
  }
  const task = words.join(" ").trim();
  if (!task) return { kind: "error", message: 'Uso: "/team [--agents claude,codex] [--concurrency 2] <tarefa>".' };
  return {
    kind: "team",
    task,
    ...(agents ? { agents } : {}),
    ...(concurrency ? { concurrency } : {}),
  };
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
  const rawArg = rest.join(" ").trim();
  const arg = rawArg.toLowerCase();

  switch (command) {
    case "exit":
    case "quit":
      return { kind: "exit" };
    case "history":
      return { kind: "history" };
    case "team":
      return parseTeamCommand(rawArg);
    case "help":
      return { kind: "help" };
    case "status":
    case "doctor":
      return { kind: "status" };
    case "summary":
    case "stats":
    case "cost":
      return { kind: "summary" };
    case "export":
      if (arg === "json") {
        return { kind: "export", format: "json" };
      }
      if (arg === "md" || arg === "markdown" || arg === "") {
        return { kind: "export", format: "markdown" };
      }
      return {
        kind: "error",
        message: 'Uso: "/export" (Markdown) ou "/export json" (JSON).',
      };
    case "clear":
      return { kind: "clear" };
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
        message: 'Uso: "/agent claude", "/agent antigravity", "/agent codex" ou "/agent auto" (volta ao roteamento normal).',
      };
    case "routing":
      if (isRoutingStrategy(arg)) {
        return { kind: "set-routing", routing: arg };
      }
      return {
        kind: "error",
        message: 'Uso: "/routing keyword" ou "/routing classify".',
      };
    default: {
      const visibleCmds = SLASH_COMMANDS.filter((c) => !c.hidden)
        .map((c) => `/${c.name}`)
        .join(", ");
      return {
        kind: "error",
        message: `Comando desconhecido: "/${command}". Comandos disponíveis: ${visibleCmds}.`,
      };
    }
  }
}

export interface ModeState {
  /** Agente forçado via "/agent claude|antigravity|codex" — null = roteamento normal (planTask/--auto). */
  forcedAgent: AgentName | null;
  /** Equivalente ao --auto do modo CLI: classifica via claude quando planTask vier vazio. Sem efeito quando routing="classify". */
  autoMode: boolean;
  /** Equivalente ao --routing do modo CLI — padrão "keyword". */
  routing: RoutingStrategy;
}

export const INITIAL_MODE_STATE: ModeState = {
  forcedAgent: null,
  autoMode: false,
  routing: "keyword",
};

// Só "set-agent", "toggle-auto" e "set-routing" alteram o modo; os demais retornam o estado inalterado.
export function applyModeCommand(state: ModeState, action: ParsedInput): ModeState {
  switch (action.kind) {
    case "set-agent":
      return { ...state, forcedAgent: action.agent };
    case "toggle-auto":
      return { ...state, autoMode: !state.autoMode };
    case "set-routing":
      return { ...state, routing: action.routing };
    default:
      return state;
  }
}
