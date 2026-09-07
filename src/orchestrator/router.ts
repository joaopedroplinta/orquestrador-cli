import { agentsForRoles, DEFAULT_ENABLED_AGENTS, type AgentRole } from "../agents/availability.js";
import { runClaudeCode } from "../agents/claudeCode.js";
import { AGENT_NAMES, isAgentName } from "../agents/registry.js";
import type { AgentName } from "../types.js";

// As listas apontam pro PAPEL, não pro agente: qual agente cumpre cada papel
// depende de quem está habilitado (ver agents/availability.ts). Com todos
// habilitados, pesquisa → antigravity e implementação → claude, como sempre.
const RESEARCH_KEYWORDS = ["pesquisar", "buscar", "o que é", "o que e", "última versão de", "ultima versao de"];

const IMPLEMENTATION_KEYWORDS = ["implementar", "criar arquivo", "refatorar", "corrigir bug", "corrigir"];

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

const CLASSIFICATION_ROLES: Record<Classification, AgentRole[]> = {
  pesquisa: ["pesquisa"],
  implementacao: ["implementacao"],
  ambos: ["pesquisa", "implementacao"],
};

function matchesResearch(lowered: string): boolean {
  return RESEARCH_KEYWORDS.some((keyword) => lowered.includes(keyword));
}

function matchesImplementation(lowered: string): boolean {
  return IMPLEMENTATION_KEYWORDS.some((keyword) => lowered.includes(keyword));
}

function buildPlan(classification: Classification, task: string, enabled: readonly AgentName[]): TaskStep[] {
  return agentsForRoles(CLASSIFICATION_ROLES[classification], enabled).map((agent) => ({ agent, prompt: task }));
}

// Handoff entre etapas é feito pelo pipeline via `context`; cada etapa aqui recebe o texto integral da tarefa.
// `enabled` limita quem pode receber uma etapa — um agente desabilitado (cota
// esgotada, CLI não instalado) cede o papel pro próximo da preferência.
export function planTask(task: string, enabled: readonly AgentName[] = DEFAULT_ENABLED_AGENTS): TaskStep[] {
  const lowered = task.toLowerCase();
  const needsResearch = matchesResearch(lowered);
  const needsImplementation = matchesImplementation(lowered);

  if (needsResearch && needsImplementation) return buildPlan("ambos", task, enabled);
  if (needsResearch) return buildPlan("pesquisa", task, enabled);
  if (needsImplementation) return buildPlan("implementacao", task, enabled);

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
// Também devolve `null` quando o próprio claude está desabilitado: a
// classificação depende dele especificamente, então não há como classificar
// sem ele — melhor cair no fallback do que chamar um agente que o usuário tirou.
export async function classifyTaskWithClaude(
  task: string,
  enabled: readonly AgentName[] = DEFAULT_ENABLED_AGENTS,
): Promise<TaskStep[] | null> {
  if (!enabled.includes("claude")) return null;

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
  if (!classification) return null;
  const plan = buildPlan(classification, task, enabled);
  return plan.length > 0 ? plan : null;
}
