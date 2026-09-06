#!/usr/bin/env node
import chalk from "chalk";
import { registerTeamCommands } from "./team/commands.js";
import { Command } from "commander";
import ora, { type Ora } from "ora";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { isAgentName } from "./agents/registry.js";
import { discoverProjectConfig, resolveConfigValue } from "./config.js";
import { runPipeline, runPipelines, type PipelineResult } from "./orchestrator/pipeline.js";
import { buildMarkdownReport, formatUsdCost, totalCostUsd, usageLine } from "./reporting.js";
import { getLastRun, getRunById, listRuns } from "./storage/history.js";
import {
  AgentError,
  PipelineCancelledError,
  type AgentName,
  type AgentRetryAttempt,
  type RoutingStrategy,
} from "./types.js";

function isRoutingStrategy(value: string): value is RoutingStrategy {
  return value === "keyword" || value === "classify";
}

// Descoberta acontece uma vez, cedo, e vale pra qualquer comando (run,
// history, export, ou a TUI) — mesma ideia de descoberta de CLAUDE.md do
// Claude Code, subindo diretórios a partir do cwd. Avisos de campo inválido
// aparecem sempre que o arquivo tem algum, não só quando `run` é usado.
const projectConfig = discoverProjectConfig();
if (projectConfig && projectConfig.warnings.length > 0) {
  for (const warning of projectConfig.warnings) {
    console.error(chalk.yellow(`${projectConfig.path}: ${warning}`));
  }
}

// A TUI abre quando não há nenhum subcomando registrado no commander —
// comportamento de fallback, não um "comando" propriamente dito.
const argv = process.argv.slice(2);
const isTuiInvocation = argv.length === 0;

if (isTuiInvocation) {
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
  const cfg = projectConfig?.config;
  await startTui({
    initialForcedAgent: cfg?.agent,
    initialRouting: cfg?.routing,
    initialAutoMode: cfg?.auto,
    maxRetries: cfg?.maxRetries,
    retryBaseDelayMs: cfg?.retryBaseDelayMs,
  });
  process.exit(0);
}

function printResult(result: PipelineResult): void {
  for (const step of result.steps) {
    console.log(chalk.bold(`\n[${step.agent}] (${step.durationMs}ms)`));
    console.log(step.output);
  }
}

function printRetry(agent: AgentName, info: AgentRetryAttempt & { maxRetries: number }, prefix = ""): void {
  console.log(
    chalk.yellow(
      `${prefix}⟳ [${agent}] tentativa ${info.attempt}/${info.maxRetries} falhou (${info.kind}): ${info.message} — tentando de novo em ${info.delayMs}ms`,
    ),
  );
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
      chalk.red("Entrada não é interativa (stdin não é um TTY) — não dá pra perguntar. Use --agent claude|antigravity|codex."),
    );
    return null;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question('Escolha o agente ["claude" | "antigravity" | "codex" | "cancelar"]: '))
        .trim()
        .toLowerCase();

      if (isAgentName(answer)) return answer;
      if (answer === "cancelar" || answer === "cancel") return null;

      console.log(chalk.red('Opção inválida. Digite "claude", "antigravity", "codex" ou "cancelar".'));
    }
  } finally {
    rl.close();
  }
}

const program = new Command();

program
  .name("orquestrador")
  .description("Orquestra Claude Code, Antigravity e Codex numa mesma tarefa")
  .version("0.1.0");

program
  .command("run <tarefas...>")
  .description(
    "Roda o fluxo completo pra uma tarefa. Com mais de uma tarefa, roda todas em paralelo (sem fallback interativo)",
  )
  .option("--agent <agente>", "Força o agente (claude|antigravity|codex), pulando o roteamento automático")
  .option(
    "--routing <estrategia>",
    'Estratégia de roteamento: "keyword" (padrão, por palavra-chave) ou "classify" ' +
      "(classifica toda tarefa via claude, sem tentar keyword antes)",
  )
  .option(
    "--auto",
    'Com --routing=keyword (padrão), se a palavra-chave for ambígua, classifica a tarefa via claude antes de ' +
      "perguntar. Sem efeito com --routing=classify (a classificação já sempre acontece)",
  )
  .action(async (tarefas: string[], opts: { agent?: string; routing?: string; auto?: boolean }) => {
    if (opts.agent && !isAgentName(opts.agent)) {
      console.error(chalk.red(`--agent inválido: "${opts.agent}". Use "claude", "antigravity" ou "codex".`));
      process.exitCode = 1;
      return;
    }
    if (opts.routing && !isRoutingStrategy(opts.routing)) {
      console.error(chalk.red(`--routing inválido: "${opts.routing}". Use "keyword" ou "classify".`));
      process.exitCode = 1;
      return;
    }
    // Prioridade em cada campo: flag de CLI > .orquestradorrc do projeto >
    // default global (aplicado mais embaixo, em pipeline.ts/agents/shared.ts,
    // quando o valor final ainda é undefined aqui).
    const cfg = projectConfig?.config;
    const forceAgent = resolveConfigValue(opts.agent as AgentName | undefined, cfg?.agent);
    const routing = resolveConfigValue(opts.routing as RoutingStrategy | undefined, cfg?.routing);
    const auto = resolveConfigValue(opts.auto, cfg?.auto);
    // maxRetries/retryBaseDelayMs não têm flag de CLI própria hoje — só
    // .orquestradorrc ou o default global de runAgentCommand.
    const maxRetries = cfg?.maxRetries;
    const retryBaseDelayMs = cfg?.retryBaseDelayMs;

    if (tarefas.length === 1) {
      const tarefa = tarefas[0]!;
      const spinner = ora(`Rodando: ${tarefa}`).start();
      try {
        const result = await runPipeline({
          task: tarefa,
          forceAgent,
          routing,
          auto,
          maxRetries,
          retryBaseDelayMs,
          onRetry: (agent, info) => {
            spinner.stop();
            printRetry(agent, info);
            spinner.start(`Rodando: ${tarefa}`);
          },
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
    const results = await runPipelines({
      tasks: tarefas,
      forceAgent,
      routing,
      auto,
      maxRetries,
      retryBaseDelayMs,
      onTaskRetry: (index, agent, info) => {
        printRetry(agent, info, `[Tarefa ${index + 1}/${tarefas.length}] `);
      },
    });

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
  .command("export <runId>")
  .description(
    "Gera um relatório em markdown de uma execução do histórico (id completo ou o prefixo de 8 caracteres mostrado em history)",
  )
  .option("-o, --output <arquivo>", "Escreve o relatório num arquivo em vez de imprimir no stdout")
  .action((runId: string, opts: { output?: string }) => {
    const run = getRunById(runId);
    if (!run) {
      console.error(chalk.red(`Nenhuma execução encontrada com id "${runId}".`));
      process.exitCode = 1;
      return;
    }

    const report = buildMarkdownReport(run);
    if (opts.output) {
      writeFileSync(opts.output, report, "utf8");
      console.log(chalk.green(`Relatório salvo em ${opts.output}`));
    } else {
      console.log(report);
    }
  });

program
  .command("history")
  .description(
    "Lista execuções passadas (só do projeto atual quando há um .orquestradorrc por perto; --all pro histórico completo)",
  )
  .option("--last", "Mostra detalhes da última execução")
  .option("--all", "Ignora o filtro por projeto (.orquestradorrc) e mostra o histórico completo")
  .action((opts: { last?: boolean; all?: boolean }) => {
    const scopeToProject = !opts.all && projectConfig !== undefined;
    const listOptions = scopeToProject ? { projectRoot: projectConfig!.dir } : {};
    const emptyMessage = scopeToProject
      ? "Nenhuma execução registrada ainda neste projeto (use --all pro histórico completo)."
      : "Nenhuma execução registrada ainda.";
    if (scopeToProject) {
      console.log(chalk.dim(`Mostrando só execuções deste projeto (${projectConfig!.dir}) — use --all pro histórico completo.\n`));
    }

    if (opts.last) {
      const run = getLastRun(listOptions);
      if (!run) {
        console.log(emptyMessage);
        return;
      }
      console.log(chalk.bold(`Run ${run.id} — ${run.task}`));
      console.log(`Início: ${run.startedAt}${run.finishedAt ? `  Fim: ${run.finishedAt}` : ""}`);
      const cost = totalCostUsd(run.steps);
      if (cost) {
        const partial = cost.stepsWithCost < run.steps.length;
        const note = partial ? chalk.dim(` (${cost.stepsWithCost}/${run.steps.length} etapas reportaram custo — parcial)`) : "";
        console.log(chalk.bold(`Custo total reportado: ${formatUsdCost(cost.total)}`) + note);
      }
      for (const step of run.steps) {
        const handoff = step.fedByStepId ? chalk.dim(` (alimentada pela etapa #${step.fedByStepId})`) : "";
        const retryTag = step.retries?.length ? chalk.yellow(` (${step.retries.length} retry(s))`) : "";
        console.log(chalk.bold(`\n[step #${step.id} — ${step.agent}] (${step.durationMs}ms)${handoff}${retryTag}`));
        console.log(chalk.dim(`Prompt: ${step.prompt}`));
        const usage = usageLine(step.usage);
        if (usage) console.log(chalk.dim(usage));
        if (step.retries?.length) {
          for (const retry of step.retries) {
            console.log(chalk.dim(`  tentativa ${retry.attempt} falhou (${retry.kind}): ${retry.message}`));
          }
        }
        console.log(step.error ? chalk.red(`Erro: ${step.error}`) : step.output);
      }
      return;
    }

    const runs = listRuns(20, listOptions);
    if (runs.length === 0) {
      console.log(emptyMessage);
      return;
    }
    for (const run of runs) {
      const agents = run.steps.map((step) => step.agent).join(", ") || "—";
      console.log(`${run.startedAt}  ${chalk.bold(run.id.slice(0, 8))}  [${agents}]  ${run.task}`);
    }
  });

registerTeamCommands(program);
program.parseAsync(process.argv);
