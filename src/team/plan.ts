import { isAgentName } from "../agents/registry.js";
import type { AgentName } from "../types.js";

export interface TeamTask {
  id: string;
  agent: AgentName;
  task: string;
  dependsOn: string[];
  /**
   * Caminhos que esta subtarefa pode alterar, em glob (`src/api/**`).
   * Opcional: um plano sem `owns` roda como antes, sem checagem de
   * sobreposição — é assim que planos anteriores continuam válidos.
   */
  owns?: string[];
}
export interface TeamPlan { tasks: TeamTask[] }

/**
 * Prefixo estático de um glob: tudo antes do primeiro curinga.
 * `src/api/**` → `src/api/`, `src/*.ts` → `src/`, `README.md` → `README.md`.
 */
function staticPrefix(pattern: string): string {
  const wildcard = pattern.search(/[*?[]/);
  return wildcard === -1 ? pattern : pattern.slice(0, wildcard);
}

/**
 * Dois padrões podem alcançar o mesmo arquivo?
 *
 * Deliberadamente conservador: compara os prefixos estáticos em fronteira de
 * diretório, então `src/*.ts` e `src/*.js` são tratados como sobrepostos
 * mesmo sem interseção real. O erro que importa evitar é o silencioso (dois
 * agentes escrevendo no mesmo arquivo e um sobrescrevendo o outro); um falso
 * positivo só obriga o plano a ser mais específico, o que é barato.
 */
export function pathsOverlap(a: string, b: string): boolean {
  const left = staticPrefix(a.replace(/^\.\//, ""));
  const right = staticPrefix(b.replace(/^\.\//, ""));
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (!longer.startsWith(shorter)) return false;
  // Só conta como contido se a fronteira for de diretório: `src/api` não
  // contém `src/apiary`, mas `src/` contém `src/api/routes.ts`.
  return shorter.endsWith("/") || longer[shorter.length] === "/";
}

/** Ids alcançáveis a partir de `id` seguindo dependsOn — quem é ancestral de quem. */
function reachable(id: string, byId: Map<string, TeamTask>, seen = new Set<string>()): Set<string> {
  for (const dependency of byId.get(id)?.dependsOn ?? []) {
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    reachable(dependency, byId, seen);
  }
  return seen;
}

/**
 * Rejeita planos em que duas subtarefas SEM relação de dependência declaram
 * caminhos que se cruzam. Sem isto, "evite editar o mesmo arquivo" é só uma
 * frase no prompt do planner — uma esperança — e a colisão só aparece no
 * merge, depois de já ter pago duas execuções de modelo.
 *
 * Tarefas ligadas por dependência (direta ou transitiva) são sequenciadas
 * pelo escalonador e recebem o commit da outra antes de começar, então
 * compartilhar caminho ali é legítimo.
 */
export function findOwnershipConflicts(tasks: TeamTask[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const ancestors = new Map(tasks.map((task) => [task.id, reachable(task.id, byId)]));
  const conflicts: string[] = [];

  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!;
      const b = tasks[j]!;
      if (!a.owns?.length || !b.owns?.length) continue;
      if (ancestors.get(a.id)?.has(b.id) || ancestors.get(b.id)?.has(a.id)) continue;
      for (const left of a.owns) {
        for (const right of b.owns) {
          if (pathsOverlap(left, right)) {
            conflicts.push(`${a.id} ("${left}") e ${b.id} ("${right}") rodam em paralelo e disputam os mesmos caminhos`);
          }
        }
      }
    }
  }
  return conflicts;
}

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
    const owns = t.owns;
    if (owns !== undefined) {
      if (!Array.isArray(owns) || !owns.every((path) => typeof path === "string" && path.trim() && !path.includes("\0"))) {
        throw new Error(`Caminhos inválidos em "owns": ${t.id}.`);
      }
      if (owns.some((path) => path.startsWith("/") || path.split("/").includes(".."))) {
        throw new Error(`"owns" deve usar caminhos relativos dentro do projeto: ${t.id}.`);
      }
    }
    return {
      id: t.id, agent: t.agent, task: t.task.trim(), dependsOn: deps,
      ...(owns ? { owns: owns.map((path) => path.trim()) } : {}),
    };
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

  // Depois do grafo estar validado (findOwnershipConflicts depende de
  // dependsOn resolvível e sem ciclo pra calcular quem é ancestral de quem).
  const conflicts = findOwnershipConflicts(tasks);
  if (conflicts.length) {
    throw new Error(
      `Plano com disputa de arquivos entre tarefas paralelas:\n  - ${conflicts.join("\n  - ")}\n` +
        "Declare uma dependência entre elas (dependsOn) ou separe os caminhos em \"owns\".",
    );
  }
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
    "Se uma tarefa precisar dos arquivos/resultados de outra, declare dependsOn.",
    'Declare em "owns" os caminhos que cada subtarefa vai alterar (globs, ex.: "src/api/**").',
    "Duas subtarefas SEM dependência entre si não podem declarar caminhos que se cruzam — o plano é",
    "rejeitado automaticamente se isso acontecer. Separe os caminhos ou declare a dependência.",
    'Responda somente JSON: {"tasks":[{"id":"backend","agent":"codex","task":"...","dependsOn":[],"owns":["src/api/**"]}]}',
    "Use no máximo 12 subtarefas e ids únicos em letras minúsculas, números e hífen.",
    `Tarefa: ${task}`,
  ].join("\n\n");
}
