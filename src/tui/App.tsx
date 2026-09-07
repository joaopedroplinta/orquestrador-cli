import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { Box, Static, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { agentsForRoles } from "../agents/availability.js";
import { AGENT_NAMES, AGENT_REGISTRY, isAgentName } from "../agents/registry.js";
import { runPipeline, runPipelines } from "../orchestrator/pipeline.js";
import { parseTaskAgentPrefix, planTask } from "../orchestrator/router.js";
import { runTeam, type TeamState } from "../team/coordinator.js";
import { formatTeamEvent } from "../team/presentation.js";
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
  type HistoryRun,
  type RoutingStrategy,
} from "../types.js";
import { agentColor } from "./agentColors.js";
import {
  applyModeCommand,
  describeAgents,
  disabledIn,
  toggleAgents,
  INITIAL_MODE_STATE,
  parseInput,
  SLASH_COMMANDS,
  type ModeState,
} from "./commands.js";
import OutputFormatter from "./OutputFormatter.js";
import PromptInput from "./PromptInput.js";
import StepCard from "./StepCard.js";
import TeamCard from "./TeamCard.js";

/** Tarefas separadas por ";" numa linha só ganham essa marca pra mostrar "Tarefa i/N" no transcript. */
interface BatchTag {
  index: number;
  total: number;
}

type TranscriptEntry =
  | { kind: "banner"; id: string; projectPath: string; agents: AgentName[] }
  | { kind: "task"; id: string; text: string; agents: AgentName[]; batch?: BatchTag }
  | { kind: "team-task"; id: string; text: string }
  | { kind: "team-result"; id: string; state: TeamState }
  | { kind: "result"; id: string; steps: AgentRunResult[]; batch?: BatchTag }
  | { kind: "error"; id: string; message: string; batch?: BatchTag }
  | { kind: "cancelled"; id: string; message: string }
  | { kind: "info"; id: string; text: string }
  | { kind: "help"; id: string }
  | { kind: "agents-card"; id: string; agents: { agent: AgentName; enabled: boolean }[] }
  | { kind: "status-card"; id: string; status: SystemStatus }
  /** `runs` vem resolvido de fora: ler SQLite dentro do render bloqueia o loop a cada re-render. */
  | { kind: "summary-card"; id: string; runs: HistoryRun[] }
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

interface LiveTeam {
  task: string;
  id?: string;
  events: string[];
  /** Última saída de cada subtarefa em andamento, por id — as "lanes" ao vivo. */
  lanes: Map<string, { agent: AgentName; output: string }>;
}

/** Mantido em sincronia com o --version do cli.ts. */
const VERSION = "0.1.0";

/** Janela pra confirmar a saída com um segundo Ctrl+C, igual ao Claude Code. */
const CTRL_C_CONFIRM_WINDOW_MS = 2000;

/** Cauda do output que cabe numa lane, pra não empurrar a tela inteira pra cima. */
const LANE_TAIL_CHARS = 220;

function laneTail(output: string): string {
  const flat = output.replace(/\s+/g, " ").trim();
  return flat.length > LANE_TAIL_CHARS ? `…${flat.slice(-LANE_TAIL_CHARS)}` : flat;
}

/** `~/projeto` em vez do caminho absoluto — é como claude e agy mostram. */
function shortenHome(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function batchPrefix(batch: BatchTag | undefined): string {
  return batch ? `Tarefa ${batch.index}/${batch.total} · ` : "";
}

// Prévia de rota mostrada assim que a tarefa é digitada, antes do pipeline
// resolver de verdade — precisa refletir a mesma prioridade de runPipeline().
function previewAgents(task: string, mode: ModeState): AgentName[] {
  if (mode.forcedAgent) return [mode.forcedAgent];
  const prefix = parseTaskAgentPrefix(task);
  if (prefix.invalidAgentName) return [];
  if (prefix.agents) return prefix.agents;
  if (prefix.agent) return [prefix.agent];
  return planTask(prefix.text, mode.enabledAgents).map((step) => step.agent);
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

/**
 * Identidade + metadados, sem caixa — mesma forma que `claude` e `agy` usam
 * (o codex encaixota, mas é o único dos três). Um bloco de marca à esquerda e
 * as informações da sessão à direita, cada uma numa linha.
 */
function Banner({ projectPath, agents }: { projectPath: string; agents: AgentName[] }) {
  const mark = ["  ▄▀▀▄  ", " ▀▄  ▄▀ ", "  ▀▄▄▀  "];
  const off = AGENT_NAMES.length - agents.length;
  const info = [
    <Text key="n" bold color="cyan">orquestrador {VERSION}</Text>,
    <Text key="a" dimColor>{`${agents.length} agentes · ${agents.join(" · ")}${off ? ` · ${off} desligado(s)` : ""}`}</Text>,
    <Text key="p" dimColor>{projectPath}</Text>,
  ];
  return (
    <Box flexDirection="column">
      {mark.map((line, i) => (
        <Box key={i}>
          <Text color="cyan">{line}</Text>
          <Text>{"  "}</Text>
          {info[i]}
        </Box>
      ))}
    </Box>
  );
}

function ComposerHint({ draft, mode }: { draft: string; mode: ModeState }) {
  const trimmed = draft.trim();
  if (!trimmed) {
    return <Text dimColor>Ex.: implementar login com testes · ou /team implementar login completo</Text>;
  }
  if (trimmed.startsWith("/")) {
    return <Text dimColor>Tab ou Enter completa · ↑/↓ escolhe um comando · Enter executa</Text>;
  }

  const tasks = trimmed.split(";").map((task) => task.trim()).filter(Boolean);
  if (tasks.length > 1) {
    return <Text color="cyan">↗ {tasks.length} tarefas serão executadas em paralelo</Text>;
  }
  const prefix = parseTaskAgentPrefix(trimmed);
  if (prefix.invalidAgentName) {
    return <Text color="red">⚠ Agente "{prefix.invalidAgentName}" não existe</Text>;
  }
  const agents = previewAgents(trimmed, mode);
  if (!agents.length) {
    return <Text dimColor>Rota ainda ambígua · você poderá escolher um agente</Text>;
  }
  return (
    <Text dimColor>
      Rota sugerida: {" "}
      {agents.map((agent, index) => (
        <Fragment key={`${agent}-${index}`}>
          {index > 0 && " → "}
          <Text color={agentColor(agent)}>{agent}</Text>
        </Fragment>
      ))}
    </Text>
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
          {"  • "}Use prefixos <Text color="magenta">claude:</Text>, <Text color="blue">antigravity:</Text> ou <Text color="green">codex:</Text> para
          forçar um agente específico por tarefa
        </Text>
        <Text dimColor>
          {"  • "}Encadeie agentes: antigravity&gt;codex&gt;claude: pesquisar, implementar e revisar
        </Text>
        <Text dimColor>
          {"  • "}Use <Text color="green">/team --agents claude,codex --concurrency 2 implementar login</Text> para configurar a equipe
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
            <>
              <Text color="green">⎇ {status.gitBranch}</Text>
              <Text color={status.gitClean ? "green" : "yellow"}> · {status.gitClean ? "limpo" : "com alterações"}</Text>
            </>
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
        <Box paddingLeft={2}>
          <Text bold color="green">Codex (codex): </Text>
          {status.codex.installed ? (
            <Text color="green">✔ {status.codex.version}</Text>
          ) : (
            <Text color="red">✖ Não encontrado no PATH ({status.codex.error})</Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}

function SummaryCardView({ runs }: { runs: HistoryRun[] }) {
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

function AgentsCardView({ agents }: { agents: { agent: AgentName; enabled: boolean }[] }) {
  const enabled = agents.filter((entry) => entry.enabled).map((entry) => entry.agent);
  const [pesquisa, implementacao] = [
    agentsForRoles(["pesquisa"], enabled)[0],
    agentsForRoles(["implementacao"], enabled)[0],
  ];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
      <Text bold color="cyan">Agentes</Text>
      {agents.map(({ agent, enabled: on }) => (
        <Box key={agent}>
          <Text color={on ? agentColor(agent) : undefined} dimColor={!on}>
            {`${on ? "●" : "○"} ${agent.padEnd(13)}`}
          </Text>
          <Text dimColor>{on ? "ligado" : "desligado"}</Text>
        </Box>
      ))}
      {/* Quem cumpre cada papel AGORA — é a pergunta real depois de desligar
          alguém ("e aí, quem faz pesquisa?"), não a lista em si. */}
      <Box marginTop={1}>
        <Text dimColor>{`Papéis: pesquisa → ${pesquisa ?? "—"} · implementação → ${implementacao ?? "—"}`}</Text>
      </Box>
      <Text dimColor>/agents off &lt;nome&gt; desliga · /agents on &lt;nome&gt; religa</Text>
    </Box>
  );
}

function StatusLine({ mode, gitBranch }: { mode: ModeState; gitBranch: string | null }) {
  const off = disabledIn(mode);
  return (
    <Box flexDirection="column">
      {/* Uma linha só, abaixo do input: estado à esquerda, um ÚNICO ponteiro
          de ajuda à direita — `? for shortcuts` do codex/agy, `/effort` do
          claude. Listar seis atalhos aqui era ruído permanente; quem quer a
          lista completa abre /help. */}
      <Box justifyContent="space-between">
        {/* Cada segmento é UM <Text> com o texto contíguo: quebrar em vários
            faz o Ink intercalar códigos ANSI no meio da frase, o que atrapalha
            leitura por teste e não ganha nada visualmente. */}
        <Box>
          {mode.forcedAgent ? (
            <Text color={agentColor(mode.forcedAgent)}>{`● ${mode.forcedAgent}`}</Text>
          ) : (
            <Text dimColor>● automático</Text>
          )}
          <Text dimColor={mode.routing !== "classify"} color={mode.routing === "classify" ? "yellow" : undefined}>
            {` · ${mode.routing}`}
          </Text>
          {mode.autoMode && <Text color="green"> · auto</Text>}
          {off.length > 0 && (
            <Text color="yellow">{` · ${mode.enabledAgents.length}/${AGENT_NAMES.length} agentes`}</Text>
          )}
          {gitBranch && <Text dimColor>{` · ⎇ ${gitBranch}`}</Text>}
        </Box>
        <Text dimColor>/help para comandos</Text>
      </Box>
    </Box>
  );
}

// ─── Componente principal App ─────────────────────────────────────────────────

export interface AppProps {
  /** Seed de ModeState.forcedAgent — vem do campo "agent" do .orquestradorrc, se houver. */
  initialForcedAgent?: AgentName;
  /** Seed de ModeState.routing — vem do campo "routing" do .orquestradorrc, se houver. */
  initialRouting?: RoutingStrategy;
  /** Seed de ModeState.autoMode — vem do campo "auto" do .orquestradorrc, se houver. */
  initialAutoMode?: boolean;
  /**
   * Seed de ModeState.enabledAgents — todos menos "disabledAgents" do
   * .orquestradorrc. Só o PONTO DE PARTIDA: "/agents on|off" muda em runtime.
   */
  initialEnabledAgents?: AgentName[];
  /**
   * Repassados direto em todo runPipeline/runPipelines da sessão — vêm do
   * .orquestradorrc do projeto. Não fazem parte de ModeState (sem slash
   * command pra mudar em runtime, diferente de agente/roteamento/auto).
   */
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export default function App({
  initialForcedAgent,
  initialRouting,
  initialAutoMode,
  initialEnabledAgents,
  maxRetries,
  retryBaseDelayMs,
}: AppProps = {}) {
  const { exit } = useApp();
  // Ctrl+C precisa ser apertado duas vezes (igual ao Claude Code) — a
  // primeira só arma um aviso por CTRL_C_CONFIRM_WINDOW_MS; se a segunda não
  // vier nesse intervalo, o armamento expira sozinho e volta a exigir duas
  // teclas de novo. `exitOnCtrlC: false` em startTui.tsx desliga o
  // auto-exit padrão do Ink, que senão sairia na primeira tecla sem passar
  // por aqui.
  const [exitArmed, setExitArmed] = useState(false);
  const exitArmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useInput((input, key) => {
    if (!key.ctrl || input !== "c") return;
    if (exitArmed) {
      if (exitArmTimeoutRef.current) clearTimeout(exitArmTimeoutRef.current);
      exit();
      return;
    }
    setExitArmed(true);
    exitArmTimeoutRef.current = setTimeout(() => setExitArmed(false), CTRL_C_CONFIRM_WINDOW_MS);
  });
  useEffect(() => () => {
    if (exitArmTimeoutRef.current) clearTimeout(exitArmTimeoutRef.current);
  }, []);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([
    {
      kind: "banner",
      id: randomUUID(),
      projectPath: shortenHome(process.cwd()),
      agents: initialEnabledAgents ?? INITIAL_MODE_STATE.enabledAgents,
    },
  ]);
  const [status, setStatus] = useState<Status>("idle");
  const [runningTask, setRunningTask] = useState<string | null>(null);
  const [pendingAgentPrompt, setPendingAgentPrompt] = useState<PendingAgentPrompt | undefined>();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [columns] = useState(() => process.stdout.columns ?? 80);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [mode, setMode] = useState<ModeState>({
    forcedAgent: initialForcedAgent ?? INITIAL_MODE_STATE.forcedAgent,
    routing: initialRouting ?? INITIAL_MODE_STATE.routing,
    autoMode: initialAutoMode ?? INITIAL_MODE_STATE.autoMode,
    enabledAgents: initialEnabledAgents ?? INITIAL_MODE_STATE.enabledAgents,
  });
  const [streamingAgent, setStreamingAgent] = useState<AgentName | null>(null);
  const [streamingOutput, setStreamingOutput] = useState("");
  const [liveTasks, setLiveTasks] = useState<LiveTask[] | null>(null);
  const [liveTeam, setLiveTeam] = useState<LiveTeam | null>(null);
  const [draft, setDraft] = useState("");

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
      const agents = previewAgents(task, mode);
      setStatus("running");
      setRunningTask(task);
      addEntry({ kind: "task", id: randomUUID(), text: task, agents });

      try {
        await runPipeline({
          task,
          forceAgent: mode.forcedAgent ?? undefined,
          routing: mode.routing,
          auto: mode.autoMode,
          enabledAgents: mode.enabledAgents,
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
          });
        } else {
          addEntry({
            kind: "error",
            id: randomUUID(),
            message: described.message,
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
        const agents = previewAgents(task, mode);
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
          enabledAgents: mode.enabledAgents,
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
            });
          } else {
            addEntry({
              kind: "error",
              id: randomUUID(),
              message: described.message,
              batch: { index: i + 1, total },
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

  const runTeamFromTui = useCallback(
    async (task: string, options: { agents?: AgentName[]; concurrency?: number } = {}) => {
      setStatus("running");
      setRunningTask(task);
      setLiveTeam({ task, events: ["Preparando equipe e verificando o repositório Git..."], lanes: new Map() });
      addEntry({ kind: "team-task", id: randomUUID(), text: task });

      try {
        const result = await runTeam({
          task,
          agents: options.agents ?? mode.enabledAgents,
          concurrency: options.concurrency,
          onEvent: (event) => {
            const formatted = formatTeamEvent(event);
            const id = event.match(/^Equipe ([a-f0-9-]{36}):/)?.[1];
            // Uma subtarefa que terminou some das lanes ao vivo — o resultado
            // dela já vai aparecer no TeamCard no fim.
            const settled = event.match(/^\[([a-z][a-z0-9-]*)\] (?:concluída|failed|blocked|cancelled)/)?.[1];
            setLiveTeam((previous) => {
              if (!previous) return previous;
              const lanes = settled ? new Map(previous.lanes) : previous.lanes;
              if (settled) lanes.delete(settled);
              return { ...previous, id: id ?? previous.id, lanes, events: [...previous.events, formatted].slice(-6) };
            });
          },
          onTaskChunk: (taskId, agent, chunk) => {
            setLiveTeam((previous) => {
              if (!previous) return previous;
              const lanes = new Map(previous.lanes);
              const current = lanes.get(taskId);
              lanes.set(taskId, { agent, output: (current?.output ?? "") + chunk });
              return { ...previous, lanes };
            });
          },
        });
        addEntry({ kind: "team-result", id: randomUUID(), state: result });
      } catch (error) {
        addEntry({
          kind: "error",
          id: randomUUID(),
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setStatus("idle");
        setRunningTask(null);
        setLiveTeam(null);
      }
    },
    [addEntry],
  );

  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      if (status === "asking-agent" && pendingAgentPrompt) {
        const answer = trimmed.toLowerCase();
        if (isAgentName(answer)) {
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
          text: 'Opção inválida. Digite "claude", "antigravity", "codex" ou "cancelar".',
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
          addEntry({ kind: "summary-card", id: randomUUID(), runs: listRuns(100) });
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
        case "list-agents":
          addEntry({ kind: "agents-card", id: randomUUID(), agents: describeAgents(mode) });
          return;
        case "toggle-agents": {
          const { mode: nextMode, error } = toggleAgents(mode, parsed.agents, parsed.enabled);
          if (error) {
            addEntry({ kind: "error", id: randomUUID(), message: error });
            return;
          }
          setMode(nextMode);
          const droppedForced = mode.forcedAgent && !nextMode.forcedAgent;
          addEntry({
            kind: "info",
            id: randomUUID(),
            text:
              `${parsed.agents.join(", ")} ${parsed.enabled ? "religado(s)" : "desligado(s)"}. ` +
              `Em jogo: ${nextMode.enabledAgents.join(", ")}.` +
              (droppedForced ? ` O agente forçado (${mode.forcedAgent}) saiu de jogo — voltando ao roteamento automático.` : ""),
          });
          return;
        }
        case "set-agent": {
          if (parsed.agent && !mode.enabledAgents.includes(parsed.agent)) {
            addEntry({
              kind: "error",
              id: randomUUID(),
              message: `"${parsed.agent}" está desligado. Religue com "/agents on ${parsed.agent}" antes de forçá-lo.`,
            });
            return;
          }
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
        case "error":
          addEntry({ kind: "error", id: randomUUID(), message: parsed.message });
          return;
        case "task":
          void runTask(parsed.text);
          return;
        case "tasks":
          void runTasksInParallel(parsed.texts);
          return;
        case "team":
          void runTeamFromTui(parsed.task, { agents: parsed.agents, concurrency: parsed.concurrency });
          return;
      }
    },
    [status, pendingAgentPrompt, mode, addEntry, exit, showHistory, runTask, runTasksInParallel, runTeamFromTui],
  );

  return (
    <Box flexDirection="column">
      <Static items={transcript}>{(entry) => <TranscriptEntryView key={entry.id} entry={entry} />}</Static>

      {status === "running" && liveTasks && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            <Spinner type="dots" /> Rodando {liveTasks.length} tarefas em
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

      {status === "running" && liveTeam && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text color="cyan">
            <Spinner type="dots" /> Equipe trabalhando <Text dimColor>({elapsedSeconds}s)</Text>
          </Text>
          <Text>{liveTeam.task}</Text>
          {liveTeam.events.map((event, index) => <Text key={`${index}-${event}`} dimColor>{event}</Text>)}
          {/* Uma lane por subtarefa em andamento: sem isto a tela fica muda
              enquanto N agentes trabalham por minutos. Caracteres de texto
              puro em vez de Box com borda — mesmo cuidado com volume de bytes
              por frame que o modo em lote já adota (ver bug #3 no CLAUDE.md). */}
          {[...liveTeam.lanes.entries()].map(([taskId, lane]) => (
            <Box key={taskId} flexDirection="column" marginTop={1}>
              <Text>
                {"┌ "}
                <Text bold color={agentColor(lane.agent)}>{taskId} · {lane.agent}</Text>
                {!AGENT_REGISTRY[lane.agent].streamsIncrementally && (
                  <Text dimColor> (entrega tudo no fim)</Text>
                )}
              </Text>
              {lane.output.length > 0 && <Text dimColor>{`│ ${laneTail(lane.output)}`}</Text>}
            </Box>
          ))}
          {liveTeam.id && <Text dimColor>Em outro terminal: orquestrador team status {liveTeam.id} --messages</Text>}
        </Box>
      )}

      {status === "running" && !liveTasks && !liveTeam && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color="cyan"><Spinner type="dots" /></Text>
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

      {/* Input delimitado por réguas, não por caixa — é a convenção que
          claude e agy seguem, e o codex nem delimita. Também gera menos bytes
          por frame que uma borda (que desenha laterais em toda linha), o que
          ajuda no risco de EIO do bug #3. */}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{"─".repeat(columns)}</Text>
        <Box>
          <Text color={status === "running" ? "gray" : "green"}>
            {status === "asking-agent" ? "> " : "❯ "}
          </Text>
          <PromptInput
            onSubmit={handleSubmit}
            onChange={setDraft}
            disabled={status === "running"}
            placeholder={status === "asking-agent" ? "claude | antigravity | codex | cancelar" : "descreva uma tarefa..."}
          />
        </Box>
        {exitArmed ? (
          <Text color="yellow">Pressione Ctrl+C de novo para sair.</Text>
        ) : (
          status === "idle" && <ComposerHint draft={draft} mode={mode} />
        )}
        <Text dimColor>{"─".repeat(columns)}</Text>
      </Box>

      {/* Estado ABAIXO do input, como claude e agy fazem: o que você digita é
          o foco, o modo é referência periférica. */}
      <StatusLine mode={mode} gitBranch={gitBranch} />
    </Box>
  );
}

// ─── Renderização de entradas do transcript ───────────────────────────────────

function TranscriptEntryView({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case "banner":
      return <Banner projectPath={entry.projectPath} agents={entry.agents} />;
    case "help":
      return <HelpView />;
    case "agents-card":
      return <AgentsCardView agents={entry.agents} />;
    case "status-card":
      return <StatusCardView status={entry.status} />;
    case "summary-card":
      return <SummaryCardView runs={entry.runs} />;
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
    case "team-task":
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan" bold>☍ equipe</Text>
          <Text>{entry.text}</Text>
        </Box>
      );
    case "team-result":
      return <TeamCard state={entry.state} />;
    case "result":
      return (
        <Box flexDirection="column">
          {entry.steps.map((step, i) => (
            <StepCard key={i} step={step} batchPrefix={batchPrefix(entry.batch)} />
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
