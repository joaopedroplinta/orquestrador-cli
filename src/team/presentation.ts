import type { TaskState, TeamState } from "./coordinator.js";

export type TeamStateLabel = "planning" | "running" | "integrating" | "completed" | "partial" | "failed" | "cancelled" | "conflict";

const TEAM_STATUS: Record<TeamStateLabel, { icon: string; label: string }> = {
  planning: { icon: "◌", label: "planejando" },
  running: { icon: "●", label: "em execução" },
  integrating: { icon: "↻", label: "integrando" },
  completed: { icon: "✓", label: "concluída" },
  partial: { icon: "◐", label: "parcial" },
  failed: { icon: "✕", label: "falhou" },
  cancelled: { icon: "■", label: "cancelada" },
  conflict: { icon: "!", label: "conflito na integração" },
};

const TASK_STATUS: Record<TaskState["status"], { icon: string; label: string }> = {
  pending: { icon: "○", label: "aguardando" },
  running: { icon: "●", label: "executando" },
  completed: { icon: "✓", label: "concluída" },
  failed: { icon: "✕", label: "falhou" },
  blocked: { icon: "⊘", label: "bloqueada" },
  cancelled: { icon: "■", label: "cancelada" },
};

function compact(text: string, length = 88): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= length ? singleLine : `${singleLine.slice(0, length - 1)}…`;
}

function countByStatus(state: TeamState): string {
  const counts = new Map<TaskState["status"], number>();
  for (const task of state.tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  return [...counts.entries()].map(([status, count]) => `${count} ${TASK_STATUS[status].label}`).join(" · ");
}

/** Painel textual: sem cores para funcionar bem em pipes, logs e testes. */
export function renderTeamDashboard(state: TeamState, includeMessages = false): string {
  const team = TEAM_STATUS[state.status];
  const lines = [
    `╭─ equipe ${state.id.slice(0, 8)} ─ ${team.icon} ${team.label}`,
    `│ ${compact(state.task, 100)}`,
    `│ ${state.tasks.length} subtarefa(s)${state.tasks.length > 0 ? ` · ${countByStatus(state)}` : ""}`,
    "├─ subtarefas",
  ];

  if (state.tasks.length === 0) lines.push("│  ainda não há subtarefas registradas");
  for (const task of state.tasks) {
    const taskStatus = TASK_STATUS[task.status];
    const dependencies = task.dependsOn.length ? ` · depende de ${task.dependsOn.join(", ")}` : "";
    lines.push(`│  ${taskStatus.icon} ${task.id.padEnd(14)} ${task.agent.padEnd(12)} ${taskStatus.label}${dependencies}`);
    lines.push(`│    ${compact(task.task)}`);
    if (task.error) lines.push(`│    ↳ ${compact(task.error)}`);
  }

  if (state.integration) {
    lines.push("├─ integração");
    lines.push(`│  branch: ${state.integration.branch}`);
    lines.push(`│  worktree: ${state.integration.worktree}`);
    lines.push(`│  incluídas: ${state.integration.merged.join(", ") || "nenhuma"}`);
    if (state.integration.conflictTask) lines.push(`│  conflito: ${state.integration.conflictTask}`);
  }

  if (state.error) {
    lines.push("├─ erro");
    lines.push(`│  ${compact(state.error, 140)}`);
  }
  if (includeMessages && state.messages.length > 0) {
    lines.push(`├─ mensagens recentes (${state.messages.length})`);
    for (const message of state.messages.slice(-5)) {
      lines.push(`│  ✉ ${message.from} → ${message.to}: ${compact(message.text, 96)}`);
    }
  }

  lines.push(`╰─ registro: ${state.directory}/state.json`);
  return lines.join("\n");
}

/** Converte eventos internos em uma linha que dá para acompanhar sem conhecer a implementação. */
export function formatTeamEvent(event: string): string {
  const created = event.match(/^Equipe ([a-f0-9-]{36}): (.+)$/);
  if (created) return `✨ Equipe ${created[1]!.slice(0, 8)} criada`;
  const start = event.match(/^\[([^/\]]+)\/([^\]]+)\] iniciando$/);
  if (start) return `▶ ${start[1]} · ${start[2]} iniciou`;
  const done = event.match(/^\[([^\]]+)\] concluída \(([^)]+)\)$/);
  if (done) return `✓ ${done[1]} concluída · commit ${done[2]}`;
  const issue = event.match(/^\[([^\]]+)\] (failed|cancelled|blocked)(?:: (.+))?$/);
  if (issue) return `${issue[2] === "blocked" ? "⊘" : "✕"} ${issue[1]} ${issue[2]}${issue[3] ? ` · ${compact(issue[3], 110)}` : ""}`;
  const teamMessage = event.match(/^\[mensagem ([^ ]+) → ([^\]]+)\] (.+)$/);
  if (teamMessage) return `✉ ${teamMessage[1]} → ${teamMessage[2]}: ${compact(teamMessage[3], 110)}`;
  if (event.startsWith("Planejando com ")) return `🧭 ${event}`;
  if (event.startsWith("Executando ")) return `⚙ ${event}`;
  if (event.startsWith("Integrando ")) return `↻ ${event}`;
  if (event.startsWith("Equipe ")) return `✓ ${event}`;
  return `• ${event}`;
}
