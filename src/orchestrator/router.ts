import { runClaudeCode } from "../agents/claudeCode.js";
import { AGENT_NAMES, isAgentName } from "../agents/registry.js";
import type { AgentName } from "../types.js";

const ANTIGRAVITY_KEYWORDS = ["pesquisar", "buscar", "o que é", "o que e", "última versão de", "ultima versao de"];

const CLAUDE_KEYWORDS = ["implementar", "criar arquivo", "refatorar", "corrigir bug", "corrigir"];

const CLASSIFY_TIMEOUT_MS = 30_000;

export interface TaskStep {
  agent: AgentName;
  prompt: string;
}

// Um agente ou uma sequência separados por ">", seguida de ":".
// Uma frase comum como "corrigir bug: o app trava" não é um prefixo.
const TASK_AGENT_PREFIX_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*(?:\s*>\s*[A-Za-z0-9_-]*)*)\s*:\s*/;

export interface ParsedTaskAgentPrefix {
  /** Sequência explícita, executada da esquerda para a direita com handoff. */
  agents?: AgentName[];
  /** Agente indicado por um prefixo "claude:"/"antigravity:" válido, se houver. */
  agent?: AgentName;
  /**
   * Texto sem o prefixo (quando houve um prefixo válido) — é isso que vira o
   * prompt de verdade. Sem prefixo (ou com prefixo inválido), é a tarefa
   * original, intacta.
   */
  text: string;
  /** Setado quando o texto tinha a cara de um prefixo de agente, mas o nome não bateu com nenhum agente conhecido. */
  invalidAgentName?: string;
}

// Sintaxe pra forçar o agente de UMA tarefa dentro de um lote (`;` na TUI ou
// múltiplos argumentos no `run`) sem precisar de --agent/--auto global pro
// lote inteiro: "claude: implementar X; antigravity: implementar Y". Sem
// prefixo, cai no comportamento de sempre (roteamento por keyword/--auto).
// Usado por `runPipeline()` (pipeline.ts) pra resolução de verdade, e por
// `App.tsx` (TUI) só pra acertar a prévia de rota mostrada antes de rodar.
export function parseTaskAgentPrefix(rawTask: string): ParsedTaskAgentPrefix {
  const match = rawTask.match(TASK_AGENT_PREFIX_PATTERN);
  if (!match) return { text: rawTask };

  const candidate = match[1]!.toLowerCase();
  if (candidate.includes(">")) {
    const agents = candidate.split(">").map((name) => name.trim());
    const invalid = agents.find((name) => !isAgentName(name));
    if (invalid !== undefined) return { text: rawTask, invalidAgentName: invalid || "(vazio)" };
    return { agents: agents as AgentName[], text: rawTask.slice(match[0].length) };
  }
  const agent = AGENT_NAMES.find((name) => name === candidate);
  if (!agent) return { text: rawTask, invalidAgentName: match[1] };

  return { agent, text: rawTask.slice(match[0].length) };
}

type Classification = "pesquisa" | "implementacao" | "ambos";

function matchesAntigravity(lowered: string): boolean {
  return ANTIGRAVITY_KEYWORDS.some((keyword) => lowered.includes(keyword));
}

function matchesClaude(lowered: string): boolean {
  return CLAUDE_KEYWORDS.some((keyword) => lowered.includes(keyword));
}

function buildPlan(classification: Classification, task: string): TaskStep[] {
  switch (classification) {
    case "pesquisa":
      return [{ agent: "antigravity", prompt: task }];
    case "implementacao":
      return [{ agent: "claude", prompt: task }];
    case "ambos":
      return [
        { agent: "antigravity", prompt: task },
        { agent: "claude", prompt: task },
      ];
  }
}

// Handoff entre etapas é feito pelo pipeline via `context`; cada etapa aqui recebe o texto integral da tarefa.
export function planTask(task: string): TaskStep[] {
  const lowered = task.toLowerCase();
  const needsAntigravity = matchesAntigravity(lowered);
  const needsClaude = matchesClaude(lowered);

  if (needsAntigravity && needsClaude) return buildPlan("ambos", task);
  if (needsAntigravity) return buildPlan("pesquisa", task);
  if (needsClaude) return buildPlan("implementacao", task);

  return [];
}

function parseClassification(output: string): Classification | null {
  const normalized = output
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

  const match = normalized.match(/\b(ambos|pesquisa|implementacao)\b/);
  return (match?.[1] as Classification | undefined) ?? null;
}

// Chamada leve e isolada ao claude só pra classificar — não é uma etapa do pipeline, não entra no histórico.
// `null` (falha ou resposta inesperada) sinaliza pra quem chamou cair no fallback interativo ou erro.
export async function classifyTaskWithClaude(task: string): Promise<TaskStep[] | null> {
  const prompt = [
    'Classifique a tarefa abaixo em exatamente uma palavra: "pesquisa" (só precisa',
    'de pesquisa/informação), "implementacao" (só precisa de código/arquivo), ou',
    '"ambos" (precisa das duas coisas). Responda só com essa palavra, sem mais nada.',
    "",
    `Tarefa: "${task}"`,
  ].join("\n");

  let output: string;
  try {
    const result = await runClaudeCode({ prompt, timeoutMs: CLASSIFY_TIMEOUT_MS });
    output = result.output;
  } catch {
    return null;
  }

  const classification = parseClassification(output);
  return classification ? buildPlan(classification, task) : null;
}
