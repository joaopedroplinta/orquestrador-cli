import { randomUUID } from "node:crypto";
import { Box, Static, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { useCallback, useState } from "react";
import { runPipeline } from "../orchestrator/pipeline.js";
import { listRuns } from "../storage/history.js";
import { AgentError, PipelineCancelledError, type AgentName, type AgentRunResult } from "../types.js";

type TranscriptEntry =
  | { kind: "task"; id: string; text: string }
  | { kind: "result"; id: string; steps: AgentRunResult[] }
  | { kind: "error"; id: string; message: string }
  | { kind: "cancelled"; id: string; message: string }
  | { kind: "info"; id: string; text: string };

type Status = "idle" | "running" | "asking-agent";

interface PendingAgentPrompt {
  task: string;
  resolve: (agent: AgentName | null) => void;
}

const HELP_TEXT =
  'Digite uma tarefa e aperte Enter. Comandos: "/history" (lista execuções), "/exit" ou "/quit" (sai). Ctrl+C também sai.';

export default function App() {
  const { exit } = useApp();
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([
    { kind: "info", id: randomUUID(), text: HELP_TEXT },
  ]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [runningTask, setRunningTask] = useState<string | null>(null);
  const [pendingAgentPrompt, setPendingAgentPrompt] = useState<PendingAgentPrompt | undefined>();

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
      setStatus("running");
      setRunningTask(task);
      addEntry({ kind: "task", id: randomUUID(), text: task });

      try {
        const result = await runPipeline({
          task,
          resolveAmbiguousAgent: (ambiguousTask) =>
            new Promise<AgentName | null>((resolve) => {
              setPendingAgentPrompt({ task: ambiguousTask, resolve });
              setStatus("asking-agent");
            }),
        });
        addEntry({ kind: "result", id: randomUUID(), steps: result.steps });
      } catch (error) {
        if (error instanceof PipelineCancelledError) {
          addEntry({ kind: "cancelled", id: randomUUID(), message: error.message });
        } else if (error instanceof AgentError) {
          addEntry({
            kind: "error",
            id: randomUUID(),
            message: `[${error.agent}] ${error.kind}: ${error.message}`,
          });
        } else {
          addEntry({
            kind: "error",
            id: randomUUID(),
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        setStatus("idle");
        setRunningTask(null);
      }
    },
    [addEntry],
  );

  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      setInput("");
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

      if (trimmed === "/exit" || trimmed === "/quit") {
        exit();
        return;
      }
      if (trimmed === "/history") {
        showHistory();
        return;
      }

      void runTask(trimmed);
    },
    [status, pendingAgentPrompt, addEntry, exit, showHistory, runTask],
  );

  return (
    <Box flexDirection="column">
      <Static items={transcript}>{(entry) => <TranscriptEntryView key={entry.id} entry={entry} />}</Static>

      {status === "running" && (
        <Box marginTop={1}>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text> Rodando: {runningTask}</Text>
        </Box>
      )}

      {status === "asking-agent" && pendingAgentPrompt && (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">Não consegui identificar automaticamente qual agente usar pra:</Text>
          <Text dimColor> "{pendingAgentPrompt.task}"</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="green">{status === "asking-agent" ? "> " : "orquestrador> "}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          focus={status !== "running"}
          placeholder={status === "running" ? "" : status === "asking-agent" ? "claude | antigravity | cancelar" : "digite uma tarefa..."}
        />
      </Box>
    </Box>
  );
}

function TranscriptEntryView({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case "task":
      return (
        <Box marginTop={1}>
          <Text color="green" bold>
            ›{" "}
          </Text>
          <Text>{entry.text}</Text>
        </Box>
      );
    case "result":
      return (
        <Box flexDirection="column">
          {entry.steps.map((step, i) => (
            <Box key={i} flexDirection="column" marginTop={1}>
              <Text bold>
                [{step.agent}] ({step.durationMs}ms)
              </Text>
              <Text>{step.output}</Text>
            </Box>
          ))}
        </Box>
      );
    case "error":
      return (
        <Box marginTop={1}>
          <Text color="red">{entry.message}</Text>
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
