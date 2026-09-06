import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { isAgentName } from "../agents/registry.js";
import type { TeamConfig } from "../config.js";
import { cleanupTeam, isTeamInterrupted, listTeams, readTeam, recoverTeam, runTeam, sendToTeam } from "./coordinator.js";
import { parseTeamPlan } from "./plan.js";
import { formatTeamEvent, renderTeamDashboard } from "./presentation.js";

function fail(error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
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
    .action((id: string, opts: { messages?: boolean; json?: boolean }) => {
      try {
        const state = readTeam(id);
        console.log(opts.json ? JSON.stringify(state, null, 2) : renderTeamDashboard(state, opts.messages));
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
