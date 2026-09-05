import { runAntigravity } from "./antigravity.js";
import { runClaudeCode } from "./claudeCode.js";
import type { AgentName, AgentRunner } from "../types.js";

export interface AgentDefinition {
  /** Dispara o processo do agente — ver `AgentRunner` em types.ts pra assinatura exata. */
  runner: AgentRunner;
  /**
   * Se o CLI subjacente escreve stdout de forma incremental de verdade.
   * NUNCA suponha — meça com um probe manual (spawn + log de timing dos
   * chunks) antes de setar `true`, ver CLAUDE.md pro resultado do probe
   * já feito pro claude/antigravity.
   */
  streamsIncrementally: boolean;
}

// Único lugar que lista os agentes de verdade pro resto do sistema.
// pipeline.ts, router.ts, cli.ts e a TUI leem daqui em vez de hardcodar
// "claude"/"antigravity" nas próprias listas — ver "Adicionando um novo
// agente" no CLAUDE.md pro passo a passo completo de como estender isto.
export const AGENT_REGISTRY: Record<AgentName, AgentDefinition> = {
  claude: { runner: runClaudeCode, streamsIncrementally: false },
  antigravity: { runner: runAntigravity, streamsIncrementally: true },
};

export const AGENT_NAMES = Object.keys(AGENT_REGISTRY) as AgentName[];

export function isAgentName(value: string): value is AgentName {
  return (AGENT_NAMES as string[]).includes(value);
}
