import { randomUUID } from "node:crypto";
import { Box, Static, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { Fragment, useCallback, useEffect, useState } from "react";
import { runPipeline, runPipelines } from "../orchestrator/pipeline.js";
import { planTask } from "../orchestrator/router.js";
import { listRuns } from "../storage/history.js";
import {
  AGENT_STREAMS_INCREMENTALLY,
  AgentError,
  PipelineCancelledError,
  type AgentName,
  type AgentRunResult,
} from "../types.js";
import { applyModeCommand, INITIAL_MODE_STATE, parseInput, type ModeState } from "./commands.js";
import PromptInput from "./PromptInput.js";

/** Tarefas separadas por ";" numa linha só ganham essa marca pra mostrar "Tarefa i/N" no transcript. */
interface BatchTag {
  index: number;
  total: number;
}

type TranscriptEntry =
  | { kind: "banner"; id: string }
  | { kind: "task"; id: string; text: string; agents: AgentName[]; batch?: BatchTag }
  | { kind: "result"; id: string; steps: AgentRunResult[]; batch?: BatchTag }
  | { kind: "error"; id: string; message: string; batch?: BatchTag }
  | { kind: "cancelled"; id: string; message: string }
  | { kind: "info"; id: string; text: string };

type Status = "idle" | "running" | "asking-agent";

interface PendingAgentPrompt {
  task: string;
  resolve: (agent: AgentName | null) => void;
}

/** Estado ao vivo de uma tarefa rodando dentro de um lote (`tarefa1; tarefa2`). */
interface LiveTask {
  index: number;
  total: number;
  task: string;
  agent: AgentName | null;
  streamingOutput: string;
}

function agentColor(agent: AgentName): string {
  return agent === "claude" ? "magenta" : "blue";
}

function batchPrefix(batch: BatchTag | undefined): string {
  return batch ? `Tarefa ${batch.index}/${batch.total} · ` : "";
}

// Reaproveitado pelo modo de uma tarefa só e pelo modo em lote — sempre a
// mesma leitura de erro (cancelamento vs. erro de agente vs. genérico).
function describeError(error: unknown): { kind: "error" | "cancelled"; message: string } {
  if (error instanceof PipelineCancelledError) {
    return { kind: "cancelled", message: error.message };
  }
  if (error instanceof AgentError) {
    return { kind: "error", message: `[${error.agent}] ${error.kind}: ${error.message}` };
  }
  return { kind: "error", message: error instanceof Error ? error.message : String(error) };
}

function Banner() {
  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} marginBottom={1}>
      <Text bold color="cyan">
        ⚡ orquestrador
      </Text>
      <Text dimColor>Orquestra Claude Code + Antigravity numa mesma tarefa.</Text>
      <Text dimColor>
        Digite uma tarefa e aperte Enter. Separe por <Text color="green">;</Text> pra rodar várias em paralelo.
      </Text>
      <Text dimColor>
        <Text color="green">/history</Text> · <Text color="green">/agent claude|antigravity|auto</Text> ·{" "}
        <Text color="green">/auto</Text> · <Text color="green">/exit</Text> · Ctrl+C
      </Text>
    </Box>
  );
}

function StatusLine({ mode }: { mode: ModeState }) {
  return (
    <Box marginTop={1}>
      <Text dimColor>agente: </Text>
      {mode.forcedAgent ? (
        <Text color={agentColor(mode.forcedAgent)} bold>
          {mode.forcedAgent} (forçado)
        </Text>
      ) : (
        <Text dimColor>automático</Text>
      )}
      <Text dimColor>{"   auto: "}</Text>
      <Text color={mode.autoMode ? "green" : undefined} dimColor={!mode.autoMode} bold={mode.autoMode}>
        {mode.autoMode ? "ligado" : "desligado"}
      </Text>
    </Box>
  );
}

export default function App() {
  const { exit } = useApp();
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([{ kind: "banner", id: randomUUID() }]);
  const [status, setStatus] = useState<Status>("idle");
  const [runningTask, setRunningTask] = useState<string | null>(null);
  const [pendingAgentPrompt, setPendingAgentPrompt] = useState<PendingAgentPrompt | undefined>();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [mode, setMode] = useState<ModeState>(INITIAL_MODE_STATE);
  const [streamingAgent, setStreamingAgent] = useState<AgentName | null>(null);
  const [streamingOutput, setStreamingOutput] = useState("");
  const [liveTasks, setLiveTasks] = useState<LiveTask[] | null>(null);

  useEffect(() => {
    if (status !== "running") {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [status]);

  const addEntry = useCallback((entry: TranscriptEntry) => {
    setTranscript((prev) => [...prev, entry]);
  }, []);

  const showHistory = useCallback(() => {
    const runs = listRuns();
    if (runs.length === 0) {
      addEntry({ kind: "info", id: randomUUID(), text: "Nenhuma execução registrada ainda." });
      return;
    }
    const lines = runs.map((run) => {
      const agents = run.steps.map((step) => step.agent).join(", ") || "—";
      return `${run.startedAt}  ${run.id.slice(0, 8)}  [${agents}]  ${run.task}`;
    });
    addEntry({ kind: "info", id: randomUUID(), text: lines.join("\n") });
  }, [addEntry]);

  const runTask = useCallback(
    async (task: string) => {
      const agents = mode.forcedAgent ? [mode.forcedAgent] : planTask(task).map((step) => step.agent);
      setStatus("running");
      setRunningTask(task);
      addEntry({ kind: "task", id: randomUUID(), text: task, agents });

      try {
        await runPipeline({
          task,
          forceAgent: mode.forcedAgent ?? undefined,
          auto: mode.autoMode,
          onStepStart: (agent) => {
            setStreamingAgent(agent);
            setStreamingOutput("");
          },
          onChunk: (_agent, chunk) => {
            setStreamingOutput((prev) => prev + chunk);
          },
          onStepComplete: (stepResult) => {
            // Cada etapa vira uma entrada do transcript assim que termina —
            // não espera o resto do plano (pesquisa → implementação) pra
            // aparecer, senão a etapa anterior "sumiria" quando a próxima
            // começasse a streamar.
            addEntry({ kind: "result", id: randomUUID(), steps: [stepResult] });
          },
          resolveAmbiguousAgent: (ambiguousTask) =>
            new Promise<AgentName | null>((resolve) => {
              setPendingAgentPrompt({ task: ambiguousTask, resolve });
              setStatus("asking-agent");
            }),
        });
      } catch (error) {
        const described = describeError(error);
        if (described.kind === "cancelled") {
          addEntry({ kind: "cancelled", id: randomUUID(), message: described.message });
        } else {
          addEntry({ kind: "error", id: randomUUID(), message: described.message });
        }
      } finally {
        setStatus("idle");
        setRunningTask(null);
        setStreamingAgent(null);
        setStreamingOutput("");
      }
    },
    [addEntry, mode],
  );

  const runTasksInParallel = useCallback(
    async (texts: string[]) => {
      const total = texts.length;
      setStatus("running");
      setLiveTasks(
        texts.map((task, i) => ({ index: i + 1, total, task, agent: null, streamingOutput: "" })),
      );

      for (const [i, task] of texts.entries()) {
        const agents = mode.forcedAgent ? [mode.forcedAgent] : planTask(task).map((step) => step.agent);
        addEntry({ kind: "task", id: randomUUID(), text: task, agents, batch: { index: i + 1, total } });
      }

      try {
        // Sem resolveAmbiguousAgent aqui, igual ao `run` não-interativo — não dá
        // pra abrir vários prompts de ambiguidade concorrentes sem confundir
        // qual pergunta é de qual tarefa. Uma tarefa ambígua no lote simplesmente
        // vira um resultado de erro só pra ela, sem travar nada.
        const results = await runPipelines({
          tasks: texts,
          forceAgent: mode.forcedAgent ?? undefined,
          auto: mode.autoMode,
          onTaskStepStart: (index, agent) => {
            setLiveTasks((prev) => prev?.map((t, i) => (i === index ? { ...t, agent, streamingOutput: "" } : t)) ?? prev);
          },
          onTaskChunk: (index, _agent, chunk) => {
            setLiveTasks(
              (prev) => prev?.map((t, i) => (i === index ? { ...t, streamingOutput: t.streamingOutput + chunk } : t)) ?? prev,
            );
          },
          onTaskStepComplete: (index, stepResult) => {
            addEntry({
              kind: "result",
              id: randomUUID(),
              steps: [stepResult],
              batch: { index: index + 1, total },
            });
          },
        });

        results.forEach((result, i) => {
          if (!result.error) return;
          const described = describeError(result.error);
          if (described.kind === "cancelled") {
            addEntry({ kind: "cancelled", id: randomUUID(), message: described.message });
          } else {
            addEntry({ kind: "error", id: randomUUID(), message: described.message, batch: { index: i + 1, total } });
          }
        });
      } finally {
        setStatus("idle");
        setLiveTasks(null);
      }
    },
    [addEntry, mode],
  );

  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      if (status === "asking-agent" && pendingAgentPrompt) {
        const answer = trimmed.toLowerCase();
        if (answer === "claude" || answer === "antigravity") {
          pendingAgentPrompt.resolve(answer);
          setPendingAgentPrompt(undefined);
          setStatus("running");
          return;
        }
        if (answer === "cancelar" || answer === "cancel") {
          pendingAgentPrompt.resolve(null);
          setPendingAgentPrompt(undefined);
          setStatus("running");
          return;
        }
        addEntry({
          kind: "info",
          id: randomUUID(),
          text: 'Opção inválida. Digite "claude", "antigravity" ou "cancelar".',
        });
        return;
      }

      if (status === "running") return;

      const parsed = parseInput(trimmed);

      switch (parsed.kind) {
        case "exit":
          exit();
          return;
        case "history":
          showHistory();
          return;
        case "set-agent": {
          const nextMode = applyModeCommand(mode, parsed);
          setMode(nextMode);
          addEntry({
            kind: "info",
            id: randomUUID(),
            text: nextMode.forcedAgent
              ? `Agente forçado: ${nextMode.forcedAgent}. Use "/agent auto" pra voltar ao roteamento normal.`
              : "Roteamento normal restaurado (palavra-chave / --auto).",
          });
          return;
        }
        case "toggle-auto": {
          const nextMode = applyModeCommand(mode, parsed);
          setMode(nextMode);
          addEntry({
            kind: "info",
            id: randomUUID(),
            text: `Classificação automática (--auto) ${nextMode.autoMode ? "ligada" : "desligada"}.`,
          });
          return;
        }
        case "error":
          addEntry({ kind: "error", id: randomUUID(), message: parsed.message });
          return;
        case "task":
          void runTask(parsed.text);
          return;
        case "tasks":
          void runTasksInParallel(parsed.texts);
          return;
      }
    },
    [status, pendingAgentPrompt, mode, addEntry, exit, showHistory, runTask, runTasksInParallel],
  );

  return (
    <Box flexDirection="column">
      <Static items={transcript}>{(entry) => <TranscriptEntryView key={entry.id} entry={entry} />}</Static>

      <StatusLine mode={mode} />

      {status === "running" && liveTasks && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            <Spinner type="dots" /> Rodando {liveTasks.length} tarefas em paralelo...{" "}
            <Text dimColor>({elapsedSeconds}s)</Text>
          </Text>
          {liveTasks.map((t) => (
            <Box key={t.index} flexDirection="column" marginTop={1}>
              <Text dimColor>
                ┌ Tarefa {t.index}/{t.total}: {t.task}
              </Text>
              {t.agent && (
                <Text>
                  {"│ "}
                  <Text bold color={agentColor(t.agent)}>
                    [{t.agent}]
                    {!AGENT_STREAMS_INCREMENTALLY[t.agent] && <Text dimColor> (simulando…)</Text>}
                  </Text>
                </Text>
              )}
              {t.streamingOutput.length > 0 && <Text>{`│ ${t.streamingOutput}`}</Text>}
            </Box>
          ))}
        </Box>
      )}

      {status === "running" && !liveTasks && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text>
              {" "}
              Rodando: {runningTask} <Text dimColor>({elapsedSeconds}s)</Text>
            </Text>
          </Box>
          {streamingAgent && streamingOutput.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color={agentColor(streamingAgent)}>
                [{streamingAgent}]
                {!AGENT_STREAMS_INCREMENTALLY[streamingAgent] && <Text dimColor> (simulando…)</Text>}
              </Text>
              <Text>{streamingOutput}</Text>
            </Box>
          )}
        </Box>
      )}

      {status === "asking-agent" && pendingAgentPrompt && (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">Não consegui identificar automaticamente qual agente usar pra:</Text>
          <Text dimColor> "{pendingAgentPrompt.task}"</Text>
        </Box>
      )}

      <Box marginTop={1} borderStyle="round" borderColor={status === "running" ? "gray" : "cyan"} paddingX={1}>
        <Text color="green">{status === "asking-agent" ? "> " : "❯ "}</Text>
        <PromptInput
          onSubmit={handleSubmit}
          disabled={status === "running"}
          placeholder={status === "asking-agent" ? "claude | antigravity | cancelar" : "digite uma tarefa..."}
        />
      </Box>
    </Box>
  );
}

function TranscriptEntryView({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case "banner":
      return <Banner />;
    case "task":
      return (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color="green" bold>
              ›{" "}
            </Text>
            {entry.batch && <Text dimColor>{batchPrefix(entry.batch)}</Text>}
            <Text>{entry.text}</Text>
          </Box>
          {entry.agents.length > 0 && (
            <Text dimColor>
              {"  → "}
              {entry.agents.map((agent, i) => (
                <Fragment key={i}>
                  {i > 0 && " → "}
                  <Text color={agentColor(agent)}>{agent}</Text>
                </Fragment>
              ))}
            </Text>
          )}
        </Box>
      );
    case "result":
      return (
        <Box flexDirection="column">
          {entry.steps.map((step, i) => (
            <Box key={i} flexDirection="column" marginTop={1}>
              <Text bold color={agentColor(step.agent)}>
                {batchPrefix(entry.batch)}[{step.agent}] ({step.durationMs}ms)
              </Text>
              <Text>{step.output}</Text>
            </Box>
          ))}
        </Box>
      );
    case "error":
      return (
        <Box marginTop={1}>
          <Text color="red">
            {batchPrefix(entry.batch)}
            {entry.message}
          </Text>
        </Box>
      );
    case "cancelled":
      return (
        <Box marginTop={1}>
          <Text color="yellow">{entry.message}</Text>
        </Box>
      );
    case "info":
      return (
        <Box marginTop={1}>
          <Text dimColor>{entry.text}</Text>
        </Box>
      );
  }
}
