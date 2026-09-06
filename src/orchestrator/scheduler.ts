/**
 * Kernel de execução paralela compartilhado.
 *
 * Antes existiam dois motores independentes com garantias opostas:
 * `runPipelines` (streaming e histórico, mas sem teto de concorrência, sem
 * isolamento e sem cancelamento) e `runTeam` (todas as garantias, nenhuma
 * observabilidade). Este módulo é o denominador comum dos dois — semáforo,
 * grafo de dependências e cancelamento em cascata — sem saber o que uma
 * "tarefa" significa: quem chama decide o que `run` faz.
 *
 * Deliberadamente agnóstico de agente, Git e histórico. Ele não importa nada
 * de `agents/`, `team/` ou `storage/`; é só escalonamento.
 */

export interface SchedulerTask<T> {
  id: string;
  /** Ids que precisam terminar em "completed" antes desta começar. */
  dependsOn?: string[];
  run: (context: TaskContext<T>) => Promise<T>;
}

export interface TaskContext<T> {
  /** Abortado quando o lote é cancelado — repasse para o subprocesso. */
  signal: AbortSignal;
  /** Resultados já concluídos das dependências declaradas, na ordem de `dependsOn`. */
  dependencies: Array<{ id: string; value: T }>;
}

export type TaskStatus = "completed" | "failed" | "blocked" | "cancelled";

export interface TaskOutcome<T> {
  id: string;
  status: TaskStatus;
  value?: T;
  error?: unknown;
}

export interface RunScheduledOptions<T> {
  tasks: SchedulerTask<T>[];
  /** Máximo de tarefas simultâneas. Sem isso, um lote de 20 sobe 20 processos de agente de uma vez. */
  concurrency: number;
  signal?: AbortSignal;
  onTaskStart?: (id: string) => void;
  onTaskSettle?: (outcome: TaskOutcome<T>) => void;
}

export const DEFAULT_CONCURRENCY = 4;

/**
 * Roda o grafo respeitando dependências e o teto de concorrência.
 *
 * Semântica preservada do coordenador de equipes, que é a implementação de
 * referência:
 * - uma tarefa só começa quando TODAS as suas dependências terminaram em
 *   "completed";
 * - uma dependência que falhou, foi bloqueada ou cancelada bloqueia a
 *   dependente (que nunca roda), mas NÃO derruba tarefas independentes —
 *   elas seguem até o fim;
 * - cancelamento marca o que ainda não começou como "cancelled" e propaga o
 *   sinal para o que está em andamento.
 *
 * Nunca rejeita: uma tarefa que lança vira `status: "failed"` no resultado.
 * Quem chama decide o que é fatal.
 */
export async function runScheduled<T>(options: RunScheduledOptions<T>): Promise<TaskOutcome<T>[]> {
  const { tasks, concurrency, signal } = options;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Concorrência deve ser um inteiro maior ou igual a 1.");
  }
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) throw new Error("Ids de tarefa duplicados.");
  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!ids.has(dependency)) throw new Error(`Dependência desconhecida: ${dependency} (em ${task.id}).`);
    }
  }

  const outcomes = new Map<string, TaskOutcome<T>>();
  const pending = new Map(tasks.map((task) => [task.id, task]));
  const running = new Map<string, Promise<void>>();

  const settle = (outcome: TaskOutcome<T>) => {
    outcomes.set(outcome.id, outcome);
    options.onTaskSettle?.(outcome);
  };

  const execute = async (task: SchedulerTask<T>) => {
    options.onTaskStart?.(task.id);
    try {
      const dependencies = (task.dependsOn ?? []).map((id) => ({ id, value: outcomes.get(id)!.value as T }));
      const value = await task.run({ signal: signal ?? neverAborted(), dependencies });
      settle({ id: task.id, status: "completed", value });
    } catch (error) {
      settle({ id: task.id, status: signal?.aborted ? "cancelled" : "failed", error });
    }
  };

  while (pending.size || running.size) {
    for (const task of [...pending.values()]) {
      const dependencies = (task.dependsOn ?? []).map((id) => outcomes.get(id));

      if (signal?.aborted) {
        pending.delete(task.id);
        settle({ id: task.id, status: "cancelled", error: new Error("Execução cancelada.") });
        continue;
      }
      if (dependencies.some((outcome) => outcome && outcome.status !== "completed")) {
        pending.delete(task.id);
        settle({ id: task.id, status: "blocked", error: new Error("Uma dependência não foi concluída.") });
        continue;
      }
      if (running.size >= concurrency) break;
      if (dependencies.every((outcome) => outcome?.status === "completed")) {
        pending.delete(task.id);
        running.set(task.id, execute(task).finally(() => running.delete(task.id)));
      }
    }

    // `execute` nunca rejeita, então o race sempre resolve. Uma tarefa ainda
    // pendente cujas dependências continuam rodando só é reavaliada depois
    // que algo termina — o grafo é acíclico, então isso sempre converge.
    if (running.size) await Promise.race(running.values());
  }

  // Devolve na ordem de entrada, não na de conclusão: quem chama indexa por
  // posição (o modo em lote da TUI mapeia índice → painel).
  return tasks.map((task) => outcomes.get(task.id)!);
}

function neverAborted(): AbortSignal {
  return new AbortController().signal;
}
