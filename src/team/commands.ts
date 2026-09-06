import { readFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { isAgentName } from "../agents/registry.js";
import type { TeamConfig } from "../config.js";
import { cleanupTeam, DEFAULT_TEAM_DIRECTORY, isTeamInterrupted, listTeams, readTeam, recoverTeam, runTeam, sendToTeam } from "./coordinator.js";
import { parseTeamPlan } from "./plan.js";
import { formatTeamEvent, renderTeamDashboard } from "./presentation.js";

function fail(error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

/**
 * Acompanha `events.jsonl` ao vivo, de outro terminal. Só é possível porque a
 * F0 separou o log de eventos append-only do snapshot de estado: seguir o
 * arquivo é ler o que foi acrescentado, sem reparsear o estado inteiro.
 *
 * Faz polling do tamanho em vez de `fs.watch`: o arquivo é escrito por OUTRO
 * processo, e a semântica de watch entre processos varia por plataforma —
 * checar o tamanho a cada 300ms é previsível em todo lugar e barato.
 */
async function followTeamEvents(id: string): Promise<void> {
  const path = join(DEFAULT_TEAM_DIRECTORY, id, "events.jsonl");
  console.log(`\nAcompanhando ${path} — Ctrl+C para sair.\n`);
  let offset = 0;
  for (;;) {
    let size = 0;
    try { size = (await stat(path)).size; } catch { size = 0; }
    if (size > offset) {
      const handle = await open(path, "r");
      try {
        const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(size - offset), position: offset });
        offset += bytesRead;
        for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n").filter(Boolean)) {
          try {
            const { at, event } = JSON.parse(line) as { at: string; event: string };
            console.log(`${at.slice(11, 19)}  ${formatTeamEvent(event)}`);
          } catch { /* linha parcial: a próxima passagem relê a partir do offset não consumido */ }
        }
      } finally { await handle.close(); }
    }
    // Termina sozinho quando a equipe chega a um estado terminal.
    try {
      const state = readTeam(id);
      if (!["planning", "running", "integrating"].includes(state.status)) {
        console.log(`\nEquipe ${state.status}.`);
        return;
      }
    } catch { /* estado ainda não legível; segue acompanhando */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

export function registerTeamCommands(program: Command, config?: TeamConfig): void {
  const team = program.command("team").description("Coordena agentes em paralelo, com worktrees e mensagens");
  team.command("run <tarefa>")
    .description("Planeja subtarefas, executa dependências e prepara uma branch de integração")
    .option("--agents <nomes>", "Agentes disponíveis separados por vírgula")
    .option("--planner <agente>", "Agente coordenador (padrão: primeiro de --agents)")
    .option("--plan <arquivo>", "Plano JSON explícito; não chama o coordenador para planejar")
    .option("-j, --concurrency <numero>", "Máximo de subtarefas simultâneas (1–12)")
    .option("--timeout <ms>", "Timeout por chamada de agente em milissegundos")
    .action(async (task: string, opts: { agents?: string; planner?: string; plan?: string; concurrency?: string; timeout?: string }) => {
      const controller = new AbortController();
      const cancel = () => { console.error("Cancelando equipe; preservando worktrees e resultados..."); controller.abort(); };
      try {
        const names = (opts.agents ?? config?.agents?.join(",") ?? "claude,codex,antigravity").split(",").map((s) => s.trim());
        if (!names.every(isAgentName)) throw new Error("Use --agents claude,codex,antigravity (ou um subconjunto).");
        if (opts.planner && !isAgentName(opts.planner)) throw new Error("Coordenador inválido.");
        const timeoutMs = Number(opts.timeout ?? config?.timeoutMs ?? 300_000);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Timeout deve ser um inteiro positivo em ms.");
        const plan = opts.plan ? parseTeamPlan(JSON.parse(readFileSync(opts.plan, "utf8")), names) : undefined;
        process.on("SIGINT", cancel);
        process.on("SIGTERM", cancel);
        const result = await runTeam({
          task, agents: names, planner: opts.planner && isAgentName(opts.planner) ? opts.planner : undefined,
          plan, concurrency: Number(opts.concurrency ?? config?.concurrency ?? 3), timeoutMs, signal: controller.signal,
          bootstrap: config?.bootstrap, bootstrapTimeoutMs: config?.bootstrapTimeoutMs,
          onEvent: (event) => console.log(formatTeamEvent(event)),
        });
        console.log(`\n${renderTeamDashboard(result, true)}`);
        if (result.error) console.error(result.error);
        if (result.integration) {
          console.log(`\nRevisar: git diff ${result.base} ${result.integration.branch}`);
          if (result.status === "completed") console.log(`Depois de revisar e testar: git merge ${result.integration.branch}`);
        }
        if (result.status !== "completed") process.exitCode = result.status === "cancelled" ? 130 : 1;
      } catch (error) { fail(error); }
      finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
    });

  team.command("list")
    .description("Lista equipes registradas, inclusive execuções interrompidas")
    .option("--json", "Emite os registros completos em JSON")
    .action((opts: { json?: boolean }) => {
      try {
        const teams = listTeams();
        if (opts.json) { console.log(JSON.stringify(teams, null, 2)); return; }
        if (!teams.length) { console.log("Nenhuma equipe registrada."); return; }
        for (const state of teams) {
          const interrupted = isTeamInterrupted(state) ? " · interrompida" : "";
          console.log(`${state.id.slice(0, 8)}  ${state.status}${interrupted}  ${state.tasks.length} tarefa(s)  ${state.task}`);
        }
      } catch (error) { fail(error); }
    });

  team.command("status <id>")
    .description("Mostra tarefas, mensagens e caminhos preservados de uma equipe")
    .option("--messages", "Inclui as últimas cinco mensagens entre agentes")
    .option("--json", "Emite o estado completo em JSON para automação")
    .option("--follow", "Acompanha os eventos da equipe ao vivo, de outro terminal (Ctrl+C para sair)")
    .action(async (id: string, opts: { messages?: boolean; json?: boolean; follow?: boolean }) => {
      try {
        const state = readTeam(id);
        console.log(opts.json ? JSON.stringify(state, null, 2) : renderTeamDashboard(state, opts.messages));
        if (opts.follow) await followTeamEvents(id);
      } catch (error) { fail(error); }
    });
  team.command("send <id> <destinatario> <mensagem>")
    .description("Enfileira uma mensagem do usuário para uma subtarefa ou all")
    .action((id: string, to: string, text: string) => {
      try { sendToTeam(id, to, text); console.log("Mensagem enfileirada. A leitura depende de o agente consultar a caixa."); }
      catch (error) { fail(error); }
    });

  team.command("recover <id>")
    .description("Finaliza com segurança o registro de uma equipe interrompida, preservando worktrees")
    .action((id: string) => {
      try {
        const state = recoverTeam(id);
        console.log(renderTeamDashboard(state));
      } catch (error) { fail(error); }
    });

  team.command("cleanup <id>")
    .description("Remove worktrees terminadas; preserva alterações não salvas por padrão")
    .option("--force", "Descarta alterações não salvas ao remover as worktrees")
    .option("--delete-branches", "Também apaga as branches da equipe depois da remoção")
    .action(async (id: string, opts: { force?: boolean; deleteBranches?: boolean }) => {
      try {
        const result = await cleanupTeam(id, { force: opts.force, deleteBranches: opts.deleteBranches });
        console.log(`Worktrees removidas: ${result.removedWorktrees.length || "nenhuma"}`);
        for (const skipped of result.skippedWorktrees) console.log(`Preservada: ${skipped.path} (${skipped.reason})`);
        if (opts.deleteBranches) {
          console.log(`Branches removidas: ${result.deletedBranches.length || "nenhuma"}`);
          for (const skipped of result.skippedBranches) console.log(`Preservada: ${skipped.branch} (${skipped.reason})`);
        }
      } catch (error) { fail(error); }
    });
}
