import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_REGISTRY } from "../agents/registry.js";
import type { AgentName, AgentRunResult, AgentRunner } from "../types.js";
import { createMailbox, queueUserMessage, TeamMailbox, writeJson, type TeamMessage } from "./mailbox.js";
import { parsePlannerOutput, parseTeamPlan, plannerPrompt, type TeamPlan, type TeamTask } from "./plan.js";
import { checkpoint, createWorktree, git, inspectRepository, mergeCommit } from "./worktrees.js";

export const DEFAULT_TEAM_DIRECTORY = join(homedir(), ".orquestrador", "teams");
export interface TaskState extends TeamTask {
  status: "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled";
  worktree: string;
  branch: string;
  commit?: string;
  result?: AgentRunResult;
  error?: string;
}
export interface TeamState {
  id: string;
  task: string;
  root: string;
  base: string;
  directory: string;
  status: "planning" | "running" | "integrating" | "completed" | "partial" | "failed" | "cancelled" | "conflict";
  startedAt: string;
  finishedAt?: string;
  tasks: TaskState[];
  messages: TeamMessage[];
  plannerResult?: AgentRunResult;
  integration?: { worktree: string; branch: string; merged: string[]; conflictTask?: string };
  error?: string;
}
export interface TeamOptions {
  task: string;
  cwd?: string;
  agents?: AgentName[];
  planner?: AgentName;
  plan?: TeamPlan;
  concurrency?: number;
  timeoutMs?: number;
  directory?: string;
  signal?: AbortSignal;
  onEvent?: (event: string) => void;
  /** Injeção dos adaptadores permite testar concorrência e Git real sem chamar modelos. */
  runners?: Record<AgentName, AgentRunner>;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export async function runTeam(options: TeamOptions): Promise<TeamState> {
  const concurrency = options.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) throw new Error("Concorrência deve ser um inteiro entre 1 e 12.");
  if (!options.task.trim()) throw new Error("A tarefa não pode estar vazia.");
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) {
    throw new Error("Timeout deve ser um inteiro positivo em ms.");
  }
  const agents = options.agents ?? ["claude", "codex", "antigravity"];
  if (!agents.length || agents.some((name) => !Object.hasOwn(AGENT_REGISTRY, name))) throw new Error("Lista de agentes inválida.");
  let plan = options.plan ? parseTeamPlan(options.plan, agents) : undefined;
  const planner = options.planner ?? agents[0]!;
  if (!Object.hasOwn(AGENT_REGISTRY, planner)) throw new Error("Coordenador inválido.");
  options.signal?.throwIfAborted();
  const { root, base } = await inspectRepository(options.cwd ?? process.cwd());
  const id = randomUUID();
  const directory = join(options.directory ?? DEFAULT_TEAM_DIRECTORY, id);
  mkdirSync(directory, { recursive: true });
  const state: TeamState = { id, task: options.task, root, base, directory, status: "planning", startedAt: new Date().toISOString(), tasks: [], messages: [] };
  const save = () => writeJson(join(directory, "state.json"), state);
  const emit = (event: string) => { save(); options.onEvent?.(event); };
  const runner = (agent: AgentName) => options.runners?.[agent] ?? AGENT_REGISTRY[agent].runner;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let timer: ReturnType<typeof setInterval> | undefined;
  let mailbox: TeamMailbox | undefined;
  let pumpError: unknown;
  const running = new Map<string, Promise<void>>();
  try {
    emit(`Equipe ${id}: ${directory}`);
    if (!plan) {
      const planningPath = join(directory, "planner");
      await createWorktree(root, planningPath, `orquestrador/${id}/planner`, base);
      emit(`Planejando com ${planner}...`);
      state.plannerResult = await runner(planner)({
        prompt: plannerPrompt(options.task, agents), cwd: planningPath,
        signal: controller.signal, timeoutMs: options.timeoutMs ?? 300_000, maxRetries: 0,
      });
      plan = parsePlannerOutput(state.plannerResult.output, agents);
    }
    const endpoints = new Map<string, string>();
    // Inicializa todas as caixas antes de iniciar processos: mensagens para tarefas
    // ainda pendentes ficam disponíveis quando elas começarem.
    for (const task of plan.tasks) {
      controller.signal.throwIfAborted();
      const worktree = join(directory, task.id);
      const branch = `orquestrador/${id}/${task.id}`;
      await createWorktree(root, worktree, branch, base);
      state.tasks.push({ ...task, worktree, branch, status: "pending" });
      endpoints.set(task.id, createMailbox(worktree, plan.tasks.map((task) => task.id)));
      save();
    }
    const userDirectory = join(directory, "user");
    endpoints.set("user", createMailbox(userDirectory, plan.tasks.map((task) => task.id)));
    mailbox = new TeamMailbox(endpoints, (m) => emit(`[mensagem ${m.from} → ${m.to}] ${m.text}`));
    state.messages = mailbox.messages;
    state.status = "running";
    emit(`Executando ${state.tasks.length} subtarefas, até ${concurrency} simultâneas.`);
    timer = setInterval(() => {
      try { mailbox!.flush(); } catch (error) { pumpError = error; controller.abort(); }
    }, 200);

    const execute = async (task: TaskState) => {
      task.status = "running";
      emit(`[${task.id}/${task.agent}] iniciando`);
      try {
        const dependencies = task.dependsOn.map((id) => state.tasks.find((task) => task.id === id)!);
        for (const dependency of dependencies) await mergeCommit(task.worktree, dependency.commit!);
        controller.signal.throwIfAborted();
        task.result = await runner(task.agent)({
          cwd: task.worktree, signal: controller.signal, timeoutMs: options.timeoutMs ?? 300_000, maxRetries: 0,
          prompt: [
            `Objetivo da equipe: ${options.task}`,
            `Sua identidade: ${task.id} (${task.agent}). Sua responsabilidade: ${task.task}`,
            `Colegas: ${state.tasks.map((t) => `${t.id} (${t.agent}): ${t.task}`).join("\n")}`,
            "Trabalhe apenas nesta worktree. Não faça commits/merges. Use a caixa .orquestrador-team somente pelo utilitário descrito abaixo; não edite sua infraestrutura. O coordenador guarda seus arquivos ao terminar.",
            "As alterações das dependências declaradas já foram integradas nesta worktree. Outras worktrees são independentes.",
            'Envie mensagens durante o trabalho: node .orquestrador-team/mailbox.cjs send <id|all|user> "mensagem"',
            "Consulte as mensagens no início, antes de decisões de interface, entre etapas e antes de concluir: node .orquestrador-team/mailbox.cjs inbox",
            "Combine contratos e avise mudanças aos colegas. Mensagens não copiam arquivos. Não espere indefinidamente por respostas; registre bloqueios.",
            "Execute verificações pertinentes e finalize com resumo, arquivos alterados, testes e pendências. Dependências de pacotes não são copiadas da árvore original.",
          ].join("\n\n"),
          context: dependencies.length ? dependencies.map((d) => `[${d.id}]\n${d.result!.output}`).join("\n\n") : undefined,
        });
        controller.signal.throwIfAborted();
        mailbox!.flush();
        task.commit = await checkpoint(task.worktree, task.id);
        task.status = "completed";
        emit(`[${task.id}] concluída (${task.commit.slice(0, 8)})`);
      } catch (error) {
        task.status = controller.signal.aborted ? "cancelled" : "failed";
        task.error = message(error);
        emit(`[${task.id}] ${task.status}: ${task.error}`);
      }
    };
    while (state.tasks.some((t) => t.status === "pending") || running.size) {
      for (const task of state.tasks.filter((t) => t.status === "pending")) {
        const deps = task.dependsOn.map((id) => state.tasks.find((t) => t.id === id)!);
        if (controller.signal.aborted || deps.some((d) => ["failed", "blocked", "cancelled"].includes(d.status))) {
          task.status = controller.signal.aborted ? "cancelled" : "blocked";
          task.error = controller.signal.aborted ? "Equipe cancelada." : "Uma dependência não foi concluída.";
          emit(`[${task.id}] ${task.status}`);
        } else if (running.size < concurrency && deps.every((d) => d.status === "completed")) {
          const promise = execute(task).finally(() => running.delete(task.id));
          running.set(task.id, promise);
        }
      }
      if (running.size) await Promise.race(running.values());
    }
    mailbox.flush();
    if (pumpError) throw pumpError;
    if (controller.signal.aborted) { state.status = "cancelled"; return state; }

    if (!state.tasks.some((t) => t.status === "completed")) { state.status = "failed"; return state; }
    state.status = "integrating";
    const integration = { worktree: join(directory, "integration"), branch: `orquestrador/${id}/integration`, merged: [] as string[], conflictTask: undefined as string | undefined };
    state.integration = integration;
    await createWorktree(root, integration.worktree, integration.branch, base);
    emit("Integrando resultados em uma worktree separada...");
    // A ordem do plano pode não ser topológica; cada commit de uma tarefa já
    // contém suas dependências. Git reconhece as ancestrais nas merges seguintes.
    for (const task of state.tasks.filter((t) => t.status === "completed")) {
      if (controller.signal.aborted) { state.status = "cancelled"; return state; }
      try {
        await mergeCommit(integration.worktree, task.commit!);
        integration.merged.push(task.id);
        save();
      } catch (error) {
        const conflicts = await git(integration.worktree, ["diff", "--name-only", "--diff-filter=U"]);
        integration.conflictTask = conflicts ? task.id : undefined;
        state.status = conflicts ? "conflict" : "failed";
        state.error = message(error);
        emit(`Integração interrompida em ${task.id} (${state.status}). Verifique ${integration.worktree}.`);
        return state;
      }
    }
    state.status = state.tasks.every((t) => t.status === "completed") ? "completed" : "partial";
    emit(`Equipe ${state.status}. Resultado: ${integration.branch}`);
    return state;
  } catch (error) {
    const cancelled = controller.signal.aborted && !pumpError;
    controller.abort();
    await Promise.allSettled(running.values());
    for (const task of state.tasks.filter((t) => t.status === "pending")) {
      task.status = "cancelled";
      task.error = "Preparação ou execução da equipe interrompida.";
    }
    state.status = cancelled ? "cancelled" : "failed";
    state.error = message(error);
    return state;
  } finally {
    if (timer) clearInterval(timer);
    options.signal?.removeEventListener("abort", abort);
    state.finishedAt = new Date().toISOString();
    save();
  }
}

export function readTeam(id: string, directory = DEFAULT_TEAM_DIRECTORY): TeamState {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Id de equipe inválido.");
  return JSON.parse(readFileSync(join(directory, id, "state.json"), "utf8")) as TeamState;
}

export function sendToTeam(id: string, to: string, text: string, directory = DEFAULT_TEAM_DIRECTORY): void {
  const state = readTeam(id, directory);
  if (state.status !== "running") throw new Error("A equipe não está executando tarefas.");
  if (to !== "all" && !state.tasks.some((task) => task.id === to)) throw new Error("Destinatário desconhecido.");
  queueUserMessage(join(directory, id, "user", ".orquestrador-team"), to, text);
}
