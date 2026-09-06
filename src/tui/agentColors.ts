import type { AgentName } from "../types.js";

// Mapa em vez de ternário: um agente novo sem entrada aqui cai no fallback
// neutro em vez de herdar silenciosamente a cor de outro agente qualquer —
// ver "Adicionando um novo agente" no CLAUDE.md. Único lugar que define essa
// cor — App.tsx e StepCard.tsx importam daqui em vez de duplicar o mapa.
const AGENT_COLORS: Partial<Record<AgentName, string>> = {
  codex: "green",
  claude: "magenta",
  antigravity: "blue",
};

export function agentColor(agent: AgentName): string {
  return AGENT_COLORS[agent] ?? "white";
}
