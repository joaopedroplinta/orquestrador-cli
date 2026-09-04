import { runClaudeCode } from "../agents/claudeCode.js";
import type { AgentName } from "../types.js";

const ANTIGRAVITY_KEYWORDS = ["pesquisar", "buscar", "o que é", "o que e", "última versão de", "ultima versao de"];

const CLAUDE_KEYWORDS = ["implementar", "criar arquivo", "refatorar", "corrigir bug", "corrigir"];

const CLASSIFY_TIMEOUT_MS = 30_000;

export interface TaskStep {
  agent: AgentName;
  prompt: string;
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
