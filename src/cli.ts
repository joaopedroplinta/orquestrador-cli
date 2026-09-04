#!/usr/bin/env node
import chalk from "chalk";
import { Command } from "commander";
import ora, { type Ora } from "ora";
import { createInterface } from "node:readline/promises";
import { runPipeline, runPipelines, type PipelineResult } from "./orchestrator/pipeline.js";
import { getLastRun, listRuns } from "./storage/history.js";
import { AgentError, PipelineCancelledError, type AgentName } from "./types.js";

if (process.argv.slice(2).length === 0) {
  if (!process.stdin.isTTY) {
    console.error(
      chalk.red(
        "Entrada não é interativa (stdin não é um TTY) — não dá pra abrir a tela interativa. " +
          'Use "orquestrador run <tarefa>" ou "orquestrador history".',
      ),
    );
    process.exit(1);
  }
  const { startTui } = await import("./tui/startTui.js");
  await startTui();
  process.exit(0);
}

function printResult(result: PipelineResult): void {
  for (const step of result.steps) {
    console.log(chalk.bold(`\n[${step.agent}] (${step.durationMs}ms)`));
    console.log(step.output);
  }
}

function printError(error: unknown): void {
  if (error instanceof PipelineCancelledError) {
    console.log(chalk.yellow(error.message));
    return;
  }
  if (error instanceof AgentError) {
    console.error(chalk.red(`[${error.agent}] ${error.kind}: ${error.message}`));
    return;
  }
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
}

async function promptForAgent(task: string, spinner: Ora): Promise<AgentName | null> {
  spinner.stop();
  console.log(chalk.yellow(`\nNão consegui identificar automaticamente qual agente usar pra:`));
  console.log(chalk.dim(`  "${task}"`));

  if (!process.stdin.isTTY) {
    console.log(
      chalk.red("Entrada não é interativa (stdin não é um TTY) — não dá pra perguntar. Use --agent claude|antigravity."),
    );
    return null;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question('Escolha o agente ["claude" | "antigravity" | "cancelar"]: '))
        .trim()
        .toLowerCase();

      if (answer === "claude" || answer === "antigravity") return answer;
      if (answer === "cancelar" || answer === "cancel") return null;

      console.log(chalk.red('Opção inválida. Digite "claude", "antigravity" ou "cancelar".'));
    }
  } finally {
    rl.close();
  }
}

const program = new Command();

program
  .name("orquestrador")
  .description("Orquestra Claude Code e Antigravity numa mesma tarefa")
  .version("0.1.0");

program
  .command("run <tarefas...>")
  .description(
    "Roda o fluxo completo pra uma tarefa. Com mais de uma tarefa, roda todas em paralelo (sem fallback interativo)",
  )
  .option("--agent <agente>", "Força o agente (claude|antigravity), pulando o roteamento automático")
  .option(
    "--auto",
    "Se o roteamento por palavras-chave for ambíguo, classifica a tarefa via claude antes de perguntar",
  )
  .action(async (tarefas: string[], opts: { agent?: string; auto?: boolean }) => {
    if (opts.agent && opts.agent !== "claude" && opts.agent !== "antigravity") {
      console.error(chalk.red(`--agent inválido: "${opts.agent}". Use "claude" ou "antigravity".`));
      process.exitCode = 1;
      return;
    }
    const forceAgent = opts.agent as AgentName | undefined;

    if (tarefas.length === 1) {
      const tarefa = tarefas[0]!;
      const spinner = ora(`Rodando: ${tarefa}`).start();
      try {
        const result = await runPipeline({
          task: tarefa,
          forceAgent,
          auto: opts.auto,
          resolveAmbiguousAgent: async (task) => {
            const chosen = await promptForAgent(task, spinner);
            if (chosen) spinner.start(`Rodando: ${tarefa}`);
            return chosen;
          },
        });
        spinner.succeed(`Concluído (${result.steps.length} etapa(s))`);
        printResult(result);
      } catch (error) {
        if (error instanceof PipelineCancelledError) {
          spinner.stop();
          printError(error);
          return;
        }
        spinner.fail("Falhou");
        printError(error);
        process.exitCode = 1;
      }
      return;
    }

    console.log(chalk.dim(`Rodando ${tarefas.length} tarefas em paralelo...`));
    const results = await runPipelines({ tasks: tarefas, forceAgent, auto: opts.auto });

    let hadError = false;
    results.forEach(({ task, result, error }, i) => {
      console.log(chalk.bold(`\n=== Tarefa ${i + 1}/${tarefas.length}: "${task}" ===`));
      if (error) {
        hadError = true;
        printError(error);
      } else {
        printResult(result!);
      }
    });

    if (hadError) process.exitCode = 1;
  });

program
  .command("history")
  .description("Lista execuções passadas")
  .option("--last", "Mostra detalhes da última execução")
  .action((opts: { last?: boolean }) => {
    if (opts.last) {
      const run = getLastRun();
      if (!run) {
        console.log("Nenhuma execução registrada ainda.");
        return;
      }
      console.log(chalk.bold(`Run ${run.id} — ${run.task}`));
      console.log(`Início: ${run.startedAt}${run.finishedAt ? `  Fim: ${run.finishedAt}` : ""}`);
      for (const step of run.steps) {
        const handoff = step.fedByStepId ? chalk.dim(` (alimentada pela etapa #${step.fedByStepId})`) : "";
        console.log(chalk.bold(`\n[step #${step.id} — ${step.agent}] (${step.durationMs}ms)${handoff}`));
        console.log(chalk.dim(`Prompt: ${step.prompt}`));
        console.log(step.error ? chalk.red(`Erro: ${step.error}`) : step.output);
      }
      return;
    }

    const runs = listRuns();
    if (runs.length === 0) {
      console.log("Nenhuma execução registrada ainda.");
      return;
    }
    for (const run of runs) {
      const agents = run.steps.map((step) => step.agent).join(", ") || "—";
      console.log(`${run.startedAt}  ${chalk.bold(run.id.slice(0, 8))}  [${agents}]  ${run.task}`);
    }
  });

program.parseAsync(process.argv);
