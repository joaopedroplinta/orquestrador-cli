import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { isAgentName } from "../agents/registry.js";
import { readTeam, runTeam, sendToTeam } from "./coordinator.js";
import { parseTeamPlan } from "./plan.js";
import { formatTeamEvent, renderTeamDashboard } from "./presentation.js";

function fail(error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

export function registerTeamCommands(program: Command): void {
  const team = program.command("team").description("Coordena agentes em paralelo, com worktrees e mensagens");
  team.command("run <tarefa>")
    .description("Planeja subtarefas, executa dependências e prepara uma branch de integração")
    .option("--agents <nomes>", "Agentes disponíveis separados por vírgula", "claude,codex,antigravity")
    .option("--planner <agente>", "Agente coordenador (padrão: primeiro de --agents)")
    .option("--plan <arquivo>", "Plano JSON explícito; não chama o coordenador para planejar")
    .option("-j, --concurrency <numero>", "Máximo de subtarefas simultâneas (1–12)", "3")
    .option("--timeout <ms>", "Timeout por chamada de agente em milissegundos", "300000")
    .action(async (task: string, opts: { agents: string; planner?: string; plan?: string; concurrency: string; timeout: string }) => {
      const controller = new AbortController();
      const cancel = () => { console.error("Cancelando equipe; preservando worktrees e resultados..."); controller.abort(); };
      try {
        const names = opts.agents.split(",").map((s) => s.trim());
        if (!names.every(isAgentName)) throw new Error("Use --agents claude,codex,antigravity (ou um subconjunto).");
        if (opts.planner && !isAgentName(opts.planner)) throw new Error("Coordenador inválido.");
        const timeoutMs = Number(opts.timeout);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Timeout deve ser um inteiro positivo em ms.");
        const plan = opts.plan ? parseTeamPlan(JSON.parse(readFileSync(opts.plan, "utf8")), names) : undefined;
        process.on("SIGINT", cancel);
        process.on("SIGTERM", cancel);
        const result = await runTeam({
          task, agents: names, planner: opts.planner && isAgentName(opts.planner) ? opts.planner : undefined,
          plan, concurrency: Number(opts.concurrency), timeoutMs, signal: controller.signal,
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
}
