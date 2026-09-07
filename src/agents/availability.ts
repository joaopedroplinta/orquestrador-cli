import { AGENT_NAMES, isAgentName } from "./registry.js";
import type { AgentName } from "../types.js";

/**
 * O papel que uma etapa cumpre no plano — é o que o roteamento decide de
 * verdade. O AGENTE que cumpre o papel é derivado depois, a partir de quem
 * está habilitado: antes do suporte a desabilitar agente, papel e agente eram
 * a mesma coisa ("pesquisa" era literalmente antigravity), e por isso tirar um
 * agente da jogada quebrava o roteamento inteiro em vez de só reatribuir.
 */
export type AgentRole = "pesquisa" | "implementacao";

/**
 * Ordem de preferência por papel — o primeiro HABILITADO ganha.
 *
 * Com todos habilitados, isto reproduz exatamente o mapeamento anterior
 * (pesquisa → antigravity, implementação → claude); as posições seguintes só
 * entram em jogo quando o preferido está desabilitado. `antigravity` lidera a
 * pesquisa por causa da busca na web; `claude` lidera a implementação; `codex`
 * é o meio-termo em ambos (roda código, mas em sandbox).
 */
const ROLE_PREFERENCE: Record<AgentRole, AgentName[]> = {
  pesquisa: ["antigravity", "claude", "codex"],
  implementacao: ["claude", "codex", "antigravity"],
};

/** Todos os agentes do registro — o estado inicial quando ninguém desabilitou nada. */
export const DEFAULT_ENABLED_AGENTS: AgentName[] = [...AGENT_NAMES];

/**
 * Escolhe um agente por papel, na ordem dos papéis pedidos, preferindo NÃO
 * repetir um agente já escolhido — assim um plano de dois papéis ("ambos")
 * continua sendo um handoff real entre dois processos quando há dois agentes
 * habilitados, em vez de virar duas chamadas ao mesmo. Quando só sobra um
 * agente habilitado, os dois papéis colapsam numa única etapa (não adianta
 * fazer handoff de um agente pra ele mesmo).
 */
export function agentsForRoles(roles: readonly AgentRole[], enabled: readonly AgentName[]): AgentName[] {
  const chosen: AgentName[] = [];
  for (const role of roles) {
    const preference = ROLE_PREFERENCE[role];
    const pick =
      preference.find((agent) => enabled.includes(agent) && !chosen.includes(agent)) ??
      preference.find((agent) => enabled.includes(agent));
    if (pick && !chosen.includes(pick)) chosen.push(pick);
  }
  return chosen;
}

/** Mantém a ordem canônica de `AGENT_NAMES`, sem repetição, seja qual for a ordem de entrada. */
function normalize(agents: readonly AgentName[]): AgentName[] {
  return AGENT_NAMES.filter((agent) => agents.includes(agent));
}

export function withAgentsDisabled(enabled: readonly AgentName[], disable: readonly AgentName[]): AgentName[] {
  return normalize(enabled.filter((agent) => !disable.includes(agent)));
}

export function withAgentsEnabled(enabled: readonly AgentName[], enable: readonly AgentName[]): AgentName[] {
  return normalize([...enabled, ...enable]);
}

export function disabledAgents(enabled: readonly AgentName[]): AgentName[] {
  return AGENT_NAMES.filter((agent) => !enabled.includes(agent));
}

/**
 * Lista separada por vírgula ("claude,codex") vinda de flag de CLI, slash
 * command ou .orquestradorrc. Devolve o erro em vez de lançar — quem chama
 * decide se isso vira `console.error`, entrada de transcript ou warning de
 * config.
 */
export function parseAgentNames(raw: string): { agents: AgentName[] } | { error: string } {
  const parts = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);

  if (parts.length === 0) return { error: `Nenhum agente informado. Use ${AGENT_NAMES.join(", ")}.` };

  const unknown = parts.find((part) => !isAgentName(part));
  if (unknown) return { error: `Agente desconhecido: "${unknown}". Use ${AGENT_NAMES.join(", ")}.` };

  return { agents: normalize(parts as AgentName[]) };
}
