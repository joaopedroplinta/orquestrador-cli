import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { Box, Static, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { Fragment, useCallback, useEffect, useState } from "react";
import { AGENT_REGISTRY } from "../agents/registry.js";
import { runPipeline, runPipelines } from "../orchestrator/pipeline.js";
import { parseTaskAgentPrefix, planTask } from "../orchestrator/router.js";
import { formatUsdCost, totalCostUsd, usageLine } from "../reporting.js";
import { computeSessionStats, exportSessionToFile } from "../sessionStats.js";
import { listRuns } from "../storage/history.js";
import { getGitBranch, getSystemStatus, type SystemStatus } from "../systemStatus.js";
import {
  AgentError,
  PipelineCancelledError,
  type AgentErrorKind,
  type AgentName,
  type AgentRunResult,
  type RoutingStrategy,
} from "../types.js";
import { agentColor } from "./agentColors.js";
import {
  applyModeCommand,
  INITIAL_MODE_STATE,
  parseInput,
  SLASH_COMMANDS,
  type ModeState,
} from "./commands.js";
import { MascotBanner, MascotSpinner } from "./Mascot.js";
import { mascotFaceFor, type MascotOutcome } from "./mascot.js";
import OutputFormatter from "./OutputFormatter.js";
import PromptInput from "./PromptInput.js";
import StepCard from "./StepCard.js";

/** Tarefas separadas por ";" numa linha só ganham essa marca pra mostrar "Tarefa i/N" no transcript. */
interface BatchTag {
  index: number;
  total: number;
}

type TranscriptEntry =
  | { kind: "banner"; id: string; mascotEnabled: boolean }
  | { kind: "task"; id: string; text: string; agents: AgentName[]; batch?: BatchTag }
  | { kind: "result"; id: string; steps: AgentRunResult[]; batch?: BatchTag; mascotFace?: string }
  | { kind: "error"; id: string; message: string; batch?: BatchTag; mascotFace?: string }
  | { kind: "cancelled"; id: string; message: string; mascotFace?: string }
  | { kind: "info"; id: string; text: string }
  | { kind: "help"; id: string }
  | { kind: "status-card"; id: string; status: SystemStatus }
  | { kind: "summary-card"; id: string }
  | {
      kind: "retry";
      id: string;
      agent: AgentName;
      attempt: number;
      maxRetries: number;
      errorKind: AgentErrorKind;
      delayMs: number;
      batch?: BatchTag;
    };

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

function batchPrefix(batch: BatchTag | undefined): string {
  return batch ? `Tarefa ${batch.index}/${batch.total} · ` : "";
}

// Prévia de rota mostrada assim que a tarefa é digitada, antes do pipeline
// resolver de verdade — precisa refletir a mesma prioridade de runPipeline().
function previewAgents(task: string, forcedAgent: AgentName | null): AgentName[] {
  if (forcedAgent) return [forcedAgent];
  const prefix = parseTaskAgentPrefix(task);
  if (prefix.invalidAgentName) return [];
  if (prefix.agent) return [prefix.agent];
  return planTask(prefix.text).map((step) => step.agent);
}

function mascotFaceIfEnabled(outcome: MascotOutcome, mascotEnabled: boolean): string | undefined {
  return mascotEnabled ? mascotFaceFor(outcome) : undefined;
}

function describeError(error: unknown): { kind: "error" | "cancelled"; message: string } {
  if (error instanceof PipelineCancelledError) {
    return { kind: "cancelled", message: error.message };
  }
  if (error instanceof AgentError) {
    return { kind: "error", message: `[${error.agent}] ${error.kind}: ${error.message}` };
  }
  return { kind: "error", message: error instanceof Error ? error.message : String(error) };
}

// ─── Componentes de UI ────────────────────────────────────────────────────────

function Banner({ mascotEnabled }: { mascotEnabled: boolean }) {
  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} marginBottom={1}>
      {mascotEnabled && <MascotBanner />}
      <Text bold color="cyan">
        ⚡ orquestrador
      </Text>
      <Text dimColor>Orquestra Claude Code + Antigravity numa mesma tarefa.</Text>
      <Text dimColor>
        Digite uma tarefa e aperte Enter. Separe por <Text color="green">;</Text> pra rodar várias em paralelo.
      </Text>
      <Text dimColor>
        <Text color="green">/help</Text> · <Text color="green">/status</Text> · <Text color="green">/summary</Text> ·{" "}
        <Text color="green">/history</Text> · <Text color="green">/agent claude|antigravity|auto</Text> ·{" "}
        <Text color="green">/exit</Text> · Ctrl+C
      </Text>
    </Box>
  );
}

function HelpView() {
  const categories = ["Agente e Roteamento", "Sessão e Utilidades", "Ajuda e Diagnóstico"] as const;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
      <Text bold color="cyan">
        📖 Comandos do Orquestrador
      </Text>
      <Text dimColor>Todos os comandos iniciam com barra (/). Tab completa, ↑/↓ navega o histórico.</Text>

      {categories.map((cat) => (
        <Box key={cat} flexDirection="column" marginTop={1}>
          <Text bold color="yellow">
            {cat}:
          </Text>
          {SLASH_COMMANDS.filter((cmd) => cmd.category === cat && !cmd.hidden).map((cmd) => (
            <Box key={cmd.name} paddingLeft={2}>
              <Text bold color="green">
                {cmd.synopsis.padEnd(32)}
              </Text>
              <Text dimColor>{cmd.description}</Text>
            </Box>
          ))}
        </Box>
      ))}

      <Box marginTop={1} flexDirection="column">
        <Text bold color="yellow">
          Dicas:
        </Text>
        <Text dimColor>
          {"  • "}Separe tarefas com <Text color="green">;</Text> para execução concorrente (ex:{" "}
          <Text color="white">pesquisar auth ; criar testes</Text>)
        </Text>
        <Text dimColor>
          {"  • "}Use prefixos <Text color="magenta">claude:</Text> ou <Text color="blue">antigravity:</Text> para
          forçar um agente específico por tarefa
        </Text>
        <Text dimColor>
          {"  • "}<Text color="green">/export json</Text> exporta todas as execuções para um arquivo JSON
        </Text>
      </Box>
    </Box>
  );
}

function StatusCardView({ status }: { status: SystemStatus }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} marginY={1}>
      <Text bold color="green">
        🩺 Diagnóstico do Ambiente
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text bold>Projeto: </Text>
          <Text color="cyan">{status.projectName}</Text>
          <Text dimColor> ({status.cwd})</Text>
        </Box>
        <Box>
          <Text bold>Git Branch: </Text>
          {status.gitBranch ? (
            <Text color="green">⎇ {status.gitBranch}</Text>
          ) : (
            <Text dimColor>Não é um repositório git</Text>
          )}
        </Box>
        <Box>
          <Text bold>Node.js: </Text>
          <Text color="cyan">{status.nodeVersion}</Text>
        </Box>
        <Box>
          <Text bold>Histórico (SQLite): </Text>
          <Text color="cyan">{status.historyRunsCount} execuções registradas</Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold color="yellow">
          Ferramentas de IA:
        </Text>
        <Box paddingLeft={2}>
          <Text bold color="magenta">
            Claude Code (claude):{" "}
          </Text>
          {status.claude.installed ? (
            <Text color="green">✔ {status.claude.version}</Text>
          ) : (
            <Text color="red">✖ Não encontrado no PATH ({status.claude.error})</Text>
          )}
        </Box>
        <Box paddingLeft={2}>
          <Text bold color="blue">
            Antigravity (agy):{" "}
          </Text>
          {status.antigravity.installed ? (
            <Text color="green">✔ {status.antigravity.version}</Text>
          ) : (
            <Text color="red">✖ Não encontrado no PATH ({status.antigravity.error})</Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}

function SummaryCardView() {
  const runs = listRuns(100);

  if (runs.length === 0) {
    return (
      <Box marginY={1}>
        <Text dimColor>📊 Nenhuma execução registrada nesta sessão.</Text>
      </Box>
    );
  }

  const stats = computeSessionStats(runs);
  const totalSec = (stats.totalDurationMs / 1000).toFixed(1);
  const costText = stats.totalCostUsd > 0 ? formatUsdCost(stats.totalCostUsd) : "—";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Text bold color="yellow">
        📊 Resumo da Sessão
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text bold>Execuções: </Text>
          <Text color="cyan">{stats.totalRuns}</Text>
          <Text dimColor>   Etapas: </Text>
          <Text color="cyan">{stats.totalSteps}</Text>
          <Text dimColor>   Tempo total: </Text>
          <Text color="cyan">{totalSec}s</Text>
          <Text dimColor>   Custo estimado: </Text>
          <Text color={stats.totalCostUsd > 0 ? "green" : "white"}>{costText}</Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold color="yellow">
          Por agente:
        </Text>
        {(Object.entries(stats.agentBreakdown) as [AgentName, { steps: number; durationMs: number }][])
          .filter(([, data]) => data.steps > 0)
          .map(([agent, data]) => {
            const allSteps = runs.flatMap((r) => r.steps).filter((s) => s.agent === agent);
            const costForAgent = totalCostUsd(allSteps);
            return (
              <Box key={agent} paddingLeft={2}>
                <Text bold color={agentColor(agent)}>
                  {agent.padEnd(14)}
                </Text>
                <Text dimColor>{data.steps} etapas</Text>
                <Text dimColor>   {(data.durationMs / 1000).toFixed(1)}s</Text>
                {costForAgent && (
                  <Text dimColor>   {formatUsdCost(costForAgent.total)}</Text>
                )}
              </Box>
            );
          })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Use </Text>
        <Text color="green">/export</Text>
        <Text dimColor> para salvar um relatório Markdown ou </Text>
        <Text color="green">/export json</Text>
        <Text dimColor> para JSON.</Text>
      </Box>
    </Box>
  );
}

function StatusLine({
  mode,
  projectName,
  gitBranch,
}: {
  mode: ModeState;
  projectName: string;
  gitBranch: string | null;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text dimColor>📁 </Text>
        <Text bold color="cyan">
          {projectName}
        </Text>
        {gitBranch && (
          <Text dimColor>
            {" "}(<Text color="green">⎇ {gitBranch}</Text>)
          </Text>
        )}
      </Box>
      <Box>
        <Text dimColor>{"agente: "}</Text>
        {mode.forcedAgent ? (
          <Text color={agentColor(mode.forcedAgent)} bold>
            {mode.forcedAgent} (forçado)
          </Text>
        ) : (
          <Text dimColor>automático</Text>
        )}
        <Text dimColor>{"   roteamento: "}</Text>
        <Text bold={mode.routing === "classify"}>{mode.routing}</Text>
        <Text dimColor>{"   auto: "}</Text>
        <Text color={mode.autoMode ? "green" : undefined} dimColor={!mode.autoMode} bold={mode.autoMode}>
          {mode.autoMode ? "ligado" : "desligado"}
        </Text>
        <Text dimColor>{"   mascote: "}</Text>
        <Text color={mode.mascotEnabled ? "green" : undefined} dimColor={!mode.mascotEnabled}>
          {mode.mascotEnabled ? "ligado" : "desligado"}
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          <Text color="gray">Tab</Text> completar · <Text color="gray">↑/↓</Text> histórico ·{" "}
          <Text color="gray">/help</Text> comandos · <Text color="gray">/status</Text> diagnóstico ·{" "}
          <Text color="gray">/summary</Text> resumo · <Text color="gray">Ctrl+C</Text> sair
        </Text>
      </Box>
    </Box>
  );
}

// ─── Componente principal App ─────────────────────────────────────────────────

export interface AppProps {
  /** Estado inicial do mascote — seedado por --no-mascot ou pelo .orquestradorrc do projeto (padrão: ligado). */
  initialMascotEnabled?: boolean;
  /** Seed de ModeState.forcedAgent — vem do campo "agent" do .orquestradorrc, se houver. */
  initialForcedAgent?: AgentName;
  /** Seed de ModeState.routing — vem do campo "routing" do .orquestradorrc, se houver. */
  initialRouting?: RoutingStrategy;
  /** Seed de ModeState.autoMode — vem do campo "auto" do .orquestradorrc, se houver. */
  initialAutoMode?: boolean;
  /**
   * Repassados direto em todo runPipeline/runPipelines da sessão — vêm do
   * .orquestradorrc do projeto. Não fazem parte de ModeState (sem slash
   * command pra mudar em runtime, diferente de agente/roteamento/auto/mascote).
   */
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export default function App({
  initialMascotEnabled = true,
  initialForcedAgent,
  initialRouting,
  initialAutoMode,
  maxRetries,
  retryBaseDelayMs,
}: AppProps = {}) {
  const { exit } = useApp();
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([
    { kind: "banner", id: randomUUID(), mascotEnabled: initialMascotEnabled },
  ]);
  const [status, setStatus] = useState<Status>("idle");
  const [runningTask, setRunningTask] = useState<string | null>(null);
  const [pendingAgentPrompt, setPendingAgentPrompt] = useState<PendingAgentPrompt | undefined>();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [projectName] = useState(() => basename(process.cwd()));
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [mode, setMode] = useState<ModeState>({
    forcedAgent: initialForcedAgent ?? INITIAL_MODE_STATE.forcedAgent,
    routing: initialRouting ?? INITIAL_MODE_STATE.routing,
    autoMode: initialAutoMode ?? INITIAL_MODE_STATE.autoMode,
    mascotEnabled: initialMascotEnabled,
  });
  const [streamingAgent, setStreamingAgent] = useState<AgentName | null>(null);
  const [streamingOutput, setStreamingOutput] = useState("");
  const [liveTasks, setLiveTasks] = useState<LiveTask[] | null>(null);

  useEffect(() => {
    void getGitBranch().then(setGitBranch);
  }, []);

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
      const agents = previewAgents(task, mode.forcedAgent);
      setStatus("running");
      setRunningTask(task);
      addEntry({ kind: "task", id: randomUUID(), text: task, agents });

      try {
        await runPipeline({
          task,
          forceAgent: mode.forcedAgent ?? undefined,
          routing: mode.routing,
          auto: mode.autoMode,
          maxRetries,
          retryBaseDelayMs,
          onStepStart: (agent) => {
            setStreamingAgent(agent);
            setStreamingOutput("");
          },
          onChunk: (_agent, chunk) => {
            setStreamingOutput((prev) => prev + chunk);
          },
          onRetry: (agent, info) => {
            // A tentativa que falhou pode ter escrito output parcial (streaming
            // real) — descarta antes da próxima tentativa começar do zero.
            setStreamingOutput("");
            addEntry({
              kind: "retry",
              id: randomUUID(),
              agent,
              attempt: info.attempt,
              maxRetries: info.maxRetries,
              errorKind: info.kind,
              delayMs: info.delayMs,
            });
          },
          onStepComplete: (stepResult) => {
            // Cada etapa vira uma entrada do transcript assim que termina —
            // não espera o resto do plano (pesquisa → implementação) pra
            // aparecer, senão a etapa anterior "sumiria" quando a próxima
            // começasse a streamar.
            addEntry({
              kind: "result",
              id: randomUUID(),
              steps: [stepResult],
              mascotFace: mascotFaceIfEnabled("success", mode.mascotEnabled),
            });
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
          addEntry({
            kind: "cancelled",
            id: randomUUID(),
            message: described.message,
            mascotFace: mascotFaceIfEnabled("cancelled", mode.mascotEnabled),
          });
        } else {
          addEntry({
            kind: "error",
            id: randomUUID(),
            message: described.message,
            mascotFace: mascotFaceIfEnabled("error", mode.mascotEnabled),
          });
        }
      } finally {
        setStatus("idle");
        setRunningTask(null);
        setStreamingAgent(null);
        setStreamingOutput("");
      }
    },
    [addEntry, mode, maxRetries, retryBaseDelayMs],
  );

  const runTasksInParallel = useCallback(
    async (texts: string[]) => {
      const total = texts.length;
      setStatus("running");
      setLiveTasks(
        texts.map((task, i) => ({ index: i + 1, total, task, agent: null, streamingOutput: "" })),
      );

      for (const [i, task] of texts.entries()) {
        const agents = previewAgents(task, mode.forcedAgent);
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
          routing: mode.routing,
          auto: mode.autoMode,
          maxRetries,
          retryBaseDelayMs,
          onTaskStepStart: (index, agent) => {
            setLiveTasks((prev) => prev?.map((t, i) => (i === index ? { ...t, agent, streamingOutput: "" } : t)) ?? prev);
          },
          onTaskChunk: (index, _agent, chunk) => {
            setLiveTasks(
              (prev) => prev?.map((t, i) => (i === index ? { ...t, streamingOutput: t.streamingOutput + chunk } : t)) ?? prev,
            );
          },
          onTaskRetry: (index, agent, info) => {
            setLiveTasks(
              (prev) => prev?.map((t, i) => (i === index ? { ...t, streamingOutput: "" } : t)) ?? prev,
            );
            addEntry({
              kind: "retry",
              id: randomUUID(),
              agent,
              attempt: info.attempt,
              maxRetries: info.maxRetries,
              errorKind: info.kind,
              delayMs: info.delayMs,
              batch: { index: index + 1, total },
            });
          },
          onTaskStepComplete: (index, stepResult) => {
            addEntry({
              kind: "result",
              id: randomUUID(),
              steps: [stepResult],
              batch: { index: index + 1, total },
              mascotFace: mascotFaceIfEnabled("success", mode.mascotEnabled),
            });
          },
        });

        results.forEach((result, i) => {
          if (!result.error) return;
          const described = describeError(result.error);
          if (described.kind === "cancelled") {
            addEntry({
              kind: "cancelled",
              id: randomUUID(),
              message: described.message,
              mascotFace: mascotFaceIfEnabled("cancelled", mode.mascotEnabled),
            });
          } else {
            addEntry({
              kind: "error",
              id: randomUUID(),
              message: described.message,
              batch: { index: i + 1, total },
              mascotFace: mascotFaceIfEnabled("error", mode.mascotEnabled),
            });
          }
        });
      } finally {
        setStatus("idle");
        setLiveTasks(null);
      }
    },
    [addEntry, mode, maxRetries, retryBaseDelayMs],
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
        case "help":
          addEntry({ kind: "help", id: randomUUID() });
          return;
        case "status":
          void (async () => {
            const sysStatus = await getSystemStatus();
            addEntry({ kind: "status-card", id: randomUUID(), status: sysStatus });
          })();
          return;
        case "summary":
          addEntry({ kind: "summary-card", id: randomUUID() });
          return;
        case "export": {
          const format = parsed.format;
          try {
            const { filepath, count } = exportSessionToFile(listRuns(100), format);
            addEntry({
              kind: "info",
              id: randomUUID(),
              text: `✔ ${count} execuções exportadas para: ${filepath}`,
            });
          } catch (err) {
            addEntry({
              kind: "error",
              id: randomUUID(),
              message: `Erro ao exportar: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
          return;
        }
        case "clear":
          if (process.stdout.isTTY) {
            process.stdout.write("\x1Bc");
          }
          addEntry({ kind: "info", id: randomUUID(), text: "Histórico visual limpo." });
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
        case "set-routing": {
          const nextMode = applyModeCommand(mode, parsed);
          setMode(nextMode);
          addEntry({
            kind: "info",
            id: randomUUID(),
            text:
              nextMode.routing === "classify"
                ? "Roteamento: classify (toda tarefa é classificada via claude; /auto não tem efeito extra)."
                : "Roteamento: keyword (padrão, por palavra-chave).",
          });
          return;
        }
        case "toggle-mascot": {
          const nextMode = applyModeCommand(mode, parsed);
          setMode(nextMode);
          addEntry({
            kind: "info",
            id: randomUUID(),
            text: `Mascote ${nextMode.mascotEnabled ? "ligado" : "desligado"}.`,
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

      <StatusLine mode={mode} projectName={projectName} gitBranch={gitBranch} />

      {status === "running" && liveTasks && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            {mode.mascotEnabled ? <MascotSpinner /> : <Spinner type="dots" />} Rodando {liveTasks.length} tarefas em
            paralelo... <Text dimColor>({elapsedSeconds}s)</Text>
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
                    {!AGENT_REGISTRY[t.agent].streamsIncrementally && <Text dimColor> (simulando…)</Text>}
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
            <Text color="cyan">{mode.mascotEnabled ? <MascotSpinner /> : <Spinner type="dots" />}</Text>
            <Text>
              {" "}
              Rodando: {runningTask} <Text dimColor>({elapsedSeconds}s)</Text>
            </Text>
          </Box>
          {streamingAgent && streamingOutput.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color={agentColor(streamingAgent)}>
                [{streamingAgent}]
                {!AGENT_REGISTRY[streamingAgent].streamsIncrementally && <Text dimColor> (simulando…)</Text>}
              </Text>
              <OutputFormatter text={streamingOutput} />
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

// ─── Renderização de entradas do transcript ───────────────────────────────────

function TranscriptEntryView({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case "banner":
      return <Banner mascotEnabled={entry.mascotEnabled} />;
    case "help":
      return <HelpView />;
    case "status-card":
      return <StatusCardView status={entry.status} />;
    case "summary-card":
      return <SummaryCardView />;
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
            <StepCard
              key={i}
              step={step}
              batchPrefix={batchPrefix(entry.batch)}
              mascotFace={entry.mascotFace}
            />
          ))}
        </Box>
      );
    case "error":
      return (
        <Box marginTop={1}>
          <Text color="red">
            {entry.mascotFace ? `${entry.mascotFace} ` : ""}
            {batchPrefix(entry.batch)}
            {entry.message}
          </Text>
        </Box>
      );
    case "cancelled":
      return (
        <Box marginTop={1}>
          <Text color="yellow">
            {entry.mascotFace ? `${entry.mascotFace} ` : ""}
            {entry.message}
          </Text>
        </Box>
      );
    case "info":
      return (
        <Box marginTop={1}>
          <Text dimColor>{entry.text}</Text>
        </Box>
      );
    case "retry":
      return (
        <Box marginTop={1}>
          <Text color="yellow">
            {batchPrefix(entry.batch)}⟳{" "}
            <Text bold color={agentColor(entry.agent)}>
              [{entry.agent}]
            </Text>{" "}
            tentativa {entry.attempt}/{entry.maxRetries} falhou ({entry.errorKind}) — tentando de novo em{" "}
            {entry.delayMs}ms
          </Text>
        </Box>
      );
  }
}
