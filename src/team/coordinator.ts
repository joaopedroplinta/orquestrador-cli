import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_REGISTRY } from "../agents/registry.js";
import type { AgentName, AgentRunResult, AgentRunner } from "../types.js";
import { createMailbox, queueUserMessage, TeamMailbox, writeJson, type TeamMessage } from "./mailbox.js";
import { createContractBoard, installContractHelper } from "./contracts.js";
import { TeamStore } from "./persistence.js";
import { runScheduled } from "../orchestrator/scheduler.js";
import { parsePlannerOutput, parseTeamPlan, plannerPrompt, type TeamPlan, type TeamTask } from "./plan.js";
import {
  checkpoint,
  createWorktree,
  deleteBranch,
  git,
  inspectRepository,
  mergeCommit,
  removeWorktree,
  worktreeChanges,
} from "./worktrees.js";

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
  /** PID do processo que iniciou a equipe; usado só para detectar estado interrompido. */
  ownerPid?: number;
  recoveredAt?: string;
  cleanup?: TeamCleanupResult;
  tasks: TaskState[];
  messages: TeamMessage[];
  plannerResult?: AgentRunResult;
  integration?: {
    worktree: string;
    branch: string;
    merged: string[];
    /** Primeira tarefa conflitante — mantido para compatibilidade de leitura. */
    conflictTask?: string;
    /** Todas as tarefas que conflitaram, com os arquivos disputados. */
    conflicts: Array<{ task: string; files: string[] }>;
    /** Tarefas que falharam ao integrar por outro motivo que não conflito. */
    failed: Array<{ task: string; error: string }>;
  };
  error?: string;
}
export interface TeamCleanupResult {
  finishedAt: string;
  removedWorktrees: string[];
  skippedWorktrees: Array<{ path: string; reason: string }>;
  deletedBranches: string[];
  skippedBranches: Array<{ branch: string; reason: string }>;
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
  /**
   * Output do agente conforme ele escreve, identificado pela subtarefa dona.
   * Só é streaming de verdade para agentes com `streamsIncrementally` no
   * registro (hoje: antigravity). Para os demais o texto chega de uma vez ao
   * final — repassamos o que realmente acontece em vez de simular revelação
   * progressiva, que com N tarefas concorrentes só disputaria a tela.
   */
  onTaskChunk?: (taskId: string, agent: AgentName, chunk: string) => void;
  /** Injeção dos adaptadores permite testar concorrência e Git real sem chamar modelos. */
  runners?: Record<AgentName, AgentRunner>;
  /** Comando sem shell executado antes de cada subtarefa, por exemplo ["npm", "ci"]. */
  bootstrap?: string[];
  bootstrapTimeoutMs?: number;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function validateBootstrap(command: string[] | undefined, timeoutMs: number | undefined): void {
  if (command && (!command.length || command.some((part) => !part.trim() || part.includes("\0")))) {
    throw new Error("Bootstrap inválido: use uma lista não vazia de argumentos sem caracteres nulos.");
  }
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
    throw new Error("Timeout do bootstrap deve ser um inteiro positivo em ms.");
  }
}

async function bootstrapWorktree(path: string, command: string[] | undefined, timeoutMs: number): Promise<void> {
  if (!command) return;
  const { execa } = await import("execa");
  await execa(command[0]!, command.slice(1), { cwd: path, timeout: timeoutMs, stdio: "inherit" });
}

export async function runTeam(options: TeamOptions): Promise<TeamState> {
  const concurrency = options.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) throw new Error("Concorrência deve ser um inteiro entre 1 e 12.");
  if (!options.task.trim()) throw new Error("A tarefa não pode estar vazia.");
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) {
    throw new Error("Timeout deve ser um inteiro positivo em ms.");
  }
  validateBootstrap(options.bootstrap, options.bootstrapTimeoutMs);
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
  const state: TeamState = {
    id, task: options.task, root, base, directory, status: "planning", startedAt: new Date().toISOString(), ownerPid: process.pid, tasks: [], messages: [],
  };
  // Snapshot com debounce + log de eventos append-only, ambos assíncronos: o
  // caminho quente (uma mensagem de mailbox entregue) não pode reserializar o
  // estado inteiro de forma síncrona. Ver TeamStore em persistence.ts.
  const store = new TeamStore(directory);
  const save = () => store.save(state);
  const emit = (event: string) => { store.appendEvent(event); save(); options.onEvent?.(event); };
  const runner = (agent: AgentName) => options.runners?.[agent] ?? AGENT_REGISTRY[agent].runner;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let timer: ReturnType<typeof setInterval> | undefined;
  let mailbox: TeamMailbox | undefined;
  let pumpError: unknown;
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
    controller.signal.throwIfAborted();
    const members = plan.tasks.map((task) => task.id);
    // Cada worktree é um checkout completo; em série, 12 subtarefas num repo
    // grande são minutos de espera antes do primeiro agente ver um token.
    // `git worktree add` cria uma ref própria por tarefa (locks independentes),
    // então paralelizar é seguro. Sem teto de propósito: o plano é limitado a
    // 12 subtarefas, então o pico é conhecido e pequeno.
    const prepared = await Promise.all(
      plan.tasks.map(async (task) => {
        const worktree = join(directory, task.id);
        const branch = `orquestrador/${id}/${task.id}`;
        await createWorktree(root, worktree, branch, base);
        return { task, worktree, branch };
      }),
    );
    // Inicializa todas as caixas antes de iniciar processos: mensagens para tarefas
    // ainda pendentes ficam disponíveis quando elas começarem.
    createContractBoard(directory);
    for (const { task, worktree, branch } of prepared) {
      state.tasks.push({ ...task, worktree, branch, status: "pending" });
      endpoints.set(task.id, createMailbox(worktree, members));
      installContractHelper(worktree, directory, task.id);
    }
    save();
    const userDirectory = join(directory, "user");
    endpoints.set("user", createMailbox(userDirectory, plan.tasks.map((task) => task.id)));
    mailbox = new TeamMailbox(endpoints, (m) => emit(`[mensagem ${m.from} → ${m.to}] ${m.text}`));
    state.messages = mailbox.messages;
    state.status = "running";
    emit(`Executando ${state.tasks.length} subtarefas, até ${concurrency} simultâneas.`);
    // Durável antes de qualquer agente começar: `team send` de outro terminal
    // lê o status do disco e precisa ver "running" já na primeira mensagem.
    await store.saveNow(state);
    timer = setInterval(() => {
      void mailbox!.flush().catch((error: unknown) => { pumpError = error; controller.abort(); });
    }, 200);

    const execute = async (task: TaskState) => {
      {
        const dependencies = task.dependsOn.map((id) => state.tasks.find((task) => task.id === id)!);
        for (const dependency of dependencies) await mergeCommit(task.worktree, dependency.commit!);
        controller.signal.throwIfAborted();
        if (options.bootstrap) {
          emit(`[${task.id}] preparando dependências...`);
          await bootstrapWorktree(task.worktree, options.bootstrap, options.bootstrapTimeoutMs ?? options.timeoutMs ?? 300_000);
        }
        controller.signal.throwIfAborted();
        task.result = await runner(task.agent)({
          cwd: task.worktree, signal: controller.signal, timeoutMs: options.timeoutMs ?? 300_000, maxRetries: 0,
          onChunk: options.onTaskChunk
            ? (chunk) => options.onTaskChunk!(task.id, task.agent, chunk)
            : undefined,
          prompt: [
            `Objetivo da equipe: ${options.task}`,
            `Sua identidade: ${task.id} (${task.agent}). Sua responsabilidade: ${task.task}`,
            `Colegas: ${state.tasks.map((t) => `${t.id} (${t.agent}): ${t.task}`).join("\n")}`,
            "Trabalhe apenas nesta worktree. Não faça commits/merges. Use a caixa .orquestrador-team somente pelo utilitário descrito abaixo; não edite sua infraestrutura. O coordenador guarda seus arquivos ao terminar.",
            "As alterações das dependências declaradas já foram integradas nesta worktree. Outras worktrees são independentes.",
            'Envie mensagens durante o trabalho: node .orquestrador-team/mailbox.cjs send <id|all|user> "mensagem"',
            "Consulte as mensagens no início, antes de decisões de interface, entre etapas e antes de concluir: node .orquestrador-team/mailbox.cjs inbox",
            "Combine contratos e avise mudanças aos colegas. Mensagens não copiam arquivos. Não espere indefinidamente por respostas; registre bloqueios.",
            "Decisões que outros precisam respeitar (rotas, formato de payload, nomes de tabela) vão no quadro de contratos, não só em mensagem:",
            '  consultar: node .orquestrador-team/contracts.cjs list  ·  registrar: node .orquestrador-team/contracts.cjs set <chave> "<valor>"',
            "Consulte o quadro ANTES de definir qualquer interface. Se sua escrita for recusada, a chave já tem dono: leia o valor atual e adeque-se a ele em vez de divergir.",
            "Execute verificações pertinentes e finalize com resumo, arquivos alterados, testes e pendências. Dependências de pacotes não são copiadas da árvore original.",
          ].join("\n\n"),
          context: dependencies.length ? dependencies.map((d) => `[${d.id}]\n${d.result!.output}`).join("\n\n") : undefined,
        });
        controller.signal.throwIfAborted();
        await mailbox!.flush();
        task.commit = await checkpoint(task.worktree, task.id);
        return task.commit;
      }
    };

    // Escalonamento delegado ao kernel compartilhado com `runPipelines`
    // (orchestrator/scheduler.ts) — semáforo, grafo de dependências e
    // cancelamento moram lá. Aqui fica só o que é específico de equipe:
    // worktree, mailbox e checkpoint em Git.
    const byId = new Map(state.tasks.map((task) => [task.id, task]));
    await runScheduled<string>({
      concurrency,
      signal: controller.signal,
      tasks: state.tasks.map((task) => ({
        id: task.id,
        dependsOn: task.dependsOn,
        run: () => execute(task),
      })),
      onTaskStart: (id) => {
        const task = byId.get(id)!;
        task.status = "running";
        emit(`[${task.id}/${task.agent}] iniciando`);
      },
      onTaskSettle: (outcome) => {
        const task = byId.get(outcome.id)!;
        task.status = outcome.status;
        if (outcome.status === "completed") {
          emit(`[${task.id}] concluída (${task.commit!.slice(0, 8)})`);
          return;
        }
        task.error = outcome.status === "blocked"
          ? "Uma dependência não foi concluída."
          : message(outcome.error);
        emit(`[${task.id}] ${task.status}: ${task.error}`);
      },
    });
    await mailbox.flush();
    if (pumpError) throw pumpError;
    if (controller.signal.aborted) { state.status = "cancelled"; return state; }

    if (!state.tasks.some((t) => t.status === "completed")) { state.status = "failed"; return state; }
    state.status = "integrating";
    await store.saveNow(state);
    const integration = {
      worktree: join(directory, "integration"), branch: `orquestrador/${id}/integration`,
      merged: [] as string[], conflictTask: undefined as string | undefined,
      conflicts: [] as Array<{ task: string; files: string[] }>,
      failed: [] as Array<{ task: string; error: string }>,
    };
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
        // Um conflito NÃO descarta a integração inteira: as demais tarefas
        // ainda mergeiam limpo e o trabalho delas entra na branch. Antes, o
        // primeiro conflito fazia return e todo o resto era perdido de vista.
        const unresolved = await git(integration.worktree, ["diff", "--name-only", "--diff-filter=U"]);
        if (unresolved) {
          // Desfaz só esta merge pra worktree seguir mergeável para as próximas.
          await git(integration.worktree, ["merge", "--abort"]).catch(() => undefined);
          integration.conflicts.push({ task: task.id, files: unresolved.split("\n").filter(Boolean) });
          integration.conflictTask ??= task.id;
          emit(`Conflito ao integrar ${task.id} (${unresolved.split("\n").filter(Boolean).length} arquivo(s)); seguindo com as demais.`);
        } else {
          integration.failed.push({ task: task.id, error: message(error) });
          emit(`Falha ao integrar ${task.id}: ${message(error)}`);
        }
        save();
      }
    }
    // Segunda passagem: com tudo que fechava limpo já integrado, reencena o
    // primeiro conflito e o DEIXA em aberto na worktree. Assim a branch ganha
    // o máximo de trabalho possível (o que a primeira passagem resolve) e você
    // ainda encontra um conflito real, atual, pronto pra resolver na mão.
    if (integration.conflictTask) {
      const pendente = state.tasks.find((t) => t.id === integration.conflictTask)!;
      await mergeCommit(integration.worktree, pendente.commit!).catch(() => undefined);
    }

    if (integration.conflicts.length || integration.failed.length) {
      state.status = integration.conflicts.length ? "conflict" : "failed";
      state.error = [
        integration.conflicts.length
          ? `Conflito em: ${integration.conflicts.map((c) => `${c.task} (${c.files.join(", ")})`).join("; ")}`
          : undefined,
        integration.failed.length
          ? `Falha ao integrar: ${integration.failed.map((f) => `${f.task}: ${f.error}`).join("; ")}`
          : undefined,
        integration.merged.length
          ? `Integradas mesmo assim: ${integration.merged.join(", ")}`
          : "Nenhuma tarefa pôde ser integrada.",
      ].filter(Boolean).join(" | ");
      emit(`Integração parcial: ${integration.merged.length} de ${integration.merged.length + integration.conflicts.length + integration.failed.length}. Verifique ${integration.worktree}.`);
      return state;
    }
    state.status = state.tasks.every((t) => t.status === "completed") ? "completed" : "partial";
    emit(`Equipe ${state.status}. Resultado: ${integration.branch}`);
    return state;
  } catch (error) {
    const cancelled = controller.signal.aborted && !pumpError;
    controller.abort();
    // Nada a esperar aqui: `runScheduled` só retorna (ou propaga) depois que
    // todas as tarefas em voo terminaram, então uma exceção que chega aqui
    // veio da preparação (worktree, plano) ou da integração, não do laço.
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
    // Único ponto que espera o disco de verdade: garante que `state.json`
    // reflita o resultado final antes de `runTeam` retornar, apesar do
    // debounce usado durante a execução.
    save();
    await store.flush();
  }
}

export function readTeam(id: string, directory = DEFAULT_TEAM_DIRECTORY): TeamState {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Id de equipe inválido.");
  return JSON.parse(readFileSync(join(directory, id, "state.json"), "utf8")) as TeamState;
}

const ACTIVE_TEAM_STATUSES = new Set<TeamState["status"]>(["planning", "running", "integrating"]);

export function isTeamInterrupted(state: TeamState): boolean {
  if (!ACTIVE_TEAM_STATUSES.has(state.status)) return false;
  if (!state.ownerPid) return true; // estados gravados por versões anteriores não tinham PID.
  try {
    process.kill(state.ownerPid, 0);
    return false;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "EPERM");
  }
}

export function listTeams(directory = DEFAULT_TEAM_DIRECTORY): TeamState[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((id) => /^[a-f0-9-]{36}$/.test(id))
    .flatMap((id) => {
      try { return [readTeam(id, directory)]; } catch { return []; }
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * Um processo morto não pode ter suas chamadas de agente retomadas com
 * segurança. Recuperar torna o registro terminal e preserva todas as
 * worktrees para inspeção, nova tentativa manual ou cleanup explícito.
 */
export function recoverTeam(id: string, directory = DEFAULT_TEAM_DIRECTORY): TeamState {
  const state = readTeam(id, directory);
  if (!ACTIVE_TEAM_STATUSES.has(state.status)) return state;
  if (!isTeamInterrupted(state)) throw new Error("A equipe ainda está em execução; não é seguro recuperá-la agora.");
  for (const task of state.tasks) {
    if (task.status === "pending" || task.status === "running") {
      task.status = "cancelled";
      task.error = "Execução interrompida antes da conclusão; worktree preservada para inspeção.";
    }
  }
  state.status = "cancelled";
  state.error = "Execução interrompida; os processos de agente não são retomados automaticamente.";
  state.finishedAt = new Date().toISOString();
  state.recoveredAt = state.finishedAt;
  writeJson(join(directory, id, "state.json"), state);
  return state;
}

function cleanupTargets(state: TeamState): Array<{ path: string; branch: string }> {
  const validTask = (task: TaskState) => /^[a-z][a-z0-9-]{0,39}$/.test(task.id);
  if (!/^[a-f0-9-]{36}$/.test(state.id) || !state.tasks.every(validTask)) {
    throw new Error("Estado de equipe inválido para limpeza.");
  }
  const expected = (name: string) => join(state.directory, name);
  const targets = [
    { path: expected("planner"), branch: `orquestrador/${state.id}/planner` },
    ...state.tasks.map((task) => ({ path: expected(task.id), branch: `orquestrador/${state.id}/${task.id}` })),
  ];
  if (state.integration) targets.push({ path: expected("integration"), branch: `orquestrador/${state.id}/integration` });
  return targets;
}

export async function cleanupTeam(
  id: string,
  options: { directory?: string; force?: boolean; deleteBranches?: boolean } = {},
): Promise<TeamCleanupResult> {
  const directory = options.directory ?? DEFAULT_TEAM_DIRECTORY;
  const state = readTeam(id, directory);
  if (ACTIVE_TEAM_STATUSES.has(state.status)) {
    throw new Error(isTeamInterrupted(state)
      ? "A equipe foi interrompida. Rode `team recover <id>` antes de limpar as worktrees."
      : "A equipe ainda está em execução; não é seguro limpar as worktrees.");
  }

  const result: TeamCleanupResult = { finishedAt: new Date().toISOString(), removedWorktrees: [], skippedWorktrees: [], deletedBranches: [], skippedBranches: [] };
  for (const target of cleanupTargets(state)) {
    if (!existsSync(target.path)) continue;
    try {
      const changes = await worktreeChanges(target.path);
      if (changes.length && !options.force) {
        result.skippedWorktrees.push({ path: target.path, reason: `há alterações não salvas: ${changes.join(", ")}` });
        continue;
      }
      await removeWorktree(state.root, target.path, Boolean(options.force));
      result.removedWorktrees.push(target.path);
    } catch (error) {
      result.skippedWorktrees.push({ path: target.path, reason: message(error) });
    }
  }
  if (options.deleteBranches) {
    for (const target of cleanupTargets(state)) {
      try {
        await deleteBranch(state.root, target.branch, Boolean(options.force));
        result.deletedBranches.push(target.branch);
      } catch (error) {
        result.skippedBranches.push({ branch: target.branch, reason: message(error) });
      }
    }
  }
  state.cleanup = result;
  writeJson(join(directory, id, "state.json"), state);
  return result;
}

export function sendToTeam(id: string, to: string, text: string, directory = DEFAULT_TEAM_DIRECTORY): void {
  const state = readTeam(id, directory);
  if (state.status !== "running") throw new Error("A equipe não está executando tarefas.");
  if (to !== "all" && !state.tasks.some((task) => task.id === to)) throw new Error("Destinatário desconhecido.");
  queueUserMessage(join(directory, id, "user", ".orquestrador-team"), to, text);
}
