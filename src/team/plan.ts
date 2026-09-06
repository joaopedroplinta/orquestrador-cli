import { isAgentName } from "../agents/registry.js";
import type { AgentName } from "../types.js";

export interface TeamTask {
  id: string;
  agent: AgentName;
  task: string;
  dependsOn: string[];
}
export interface TeamPlan { tasks: TeamTask[] }

/** Valida também o grafo antes de criar worktrees ou chamar agentes. */
export function parseTeamPlan(value: unknown, allowedAgents?: AgentName[]): TeamPlan {
  if (!value || typeof value !== "object" || !("tasks" in value) || !Array.isArray(value.tasks)) {
    throw new Error('Plano inválido: esperado {"tasks":[...]}');
  }
  if (value.tasks.length < 1 || value.tasks.length > 12) throw new Error("O plano deve conter entre 1 e 12 subtarefas.");
  const tasks = value.tasks.map((item: unknown): TeamTask => {
    if (!item || typeof item !== "object") throw new Error("Subtarefa inválida.");
    const t = item as Record<string, unknown>;
    if (typeof t.id !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(t.id) || ["all", "user", "planner", "integration"].includes(t.id)) {
      throw new Error("Cada id deve usar letras minúsculas, números e hífen (1–40 caracteres; all/user/planner/integration são reservados).");
    }
    if (typeof t.agent !== "string" || !isAgentName(t.agent) || (allowedAgents && !allowedAgents.includes(t.agent))) {
      throw new Error(`Agente indisponível na subtarefa ${t.id}.`);
    }
    if (typeof t.task !== "string" || !t.task.trim() || t.task.length > 20_000) throw new Error(`Descrição inválida: ${t.id}.`);
    const deps = t.dependsOn ?? [];
    if (!Array.isArray(deps) || !deps.every((id) => typeof id === "string") || new Set(deps).size !== deps.length) {
      throw new Error(`Dependências inválidas: ${t.id}.`);
    }
    return { id: t.id, agent: t.agent, task: t.task.trim(), dependsOn: deps };
  });
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error("Ids de subtarefas duplicados.");
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error(`Ciclo de dependências: ${id}.`);
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new Error(`Dependência desconhecida: ${id}.`);
    visiting.add(id);
    task.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  tasks.forEach((task) => visit(task.id));
  return { tasks };
}

export function parsePlannerOutput(output: string, agents: AgentName[]): TeamPlan {
  const json = output.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, "");
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error("O coordenador não retornou um plano JSON válido. Use --plan para fornecer um plano explícito."); }
  return parseTeamPlan(value, agents);
}

export function plannerPrompt(task: string, agents: AgentName[]): string {
  return [
    "Planeje uma equipe de agentes para a tarefa abaixo. Apenas planeje; não altere arquivos.",
    `Agentes disponíveis: ${agents.join(", ")}. Use apenas os necessários.`,
    "Divida em subtarefas concretas com responsabilidades e critérios de conclusão claros.",
    "Subtarefas independentes executarão simultaneamente em worktrees Git isoladas.",
    "Se uma tarefa precisar dos arquivos/resultados de outra, declare dependsOn. Evite edições concorrentes no mesmo arquivo.",
    'Responda somente JSON: {"tasks":[{"id":"backend","agent":"codex","task":"...","dependsOn":[]}]}',
    "Use no máximo 12 subtarefas e ids únicos em letras minúsculas, números e hífen.",
    `Tarefa: ${task}`,
  ].join("\n\n");
}
