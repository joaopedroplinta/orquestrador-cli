import type { AgentUsage, HistoryRun, HistoryStep } from "./types.js";

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function formatUsdCost(usd: number): string {
  return `US$ ${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}

// Só soma o que cada agente de fato reportou — nunca inventa um número pro
// que falta (ver AgentUsage em types.ts e o probe manual documentado no
// CLAUDE.md). Um passo sem `usage` nenhum (agente que não expõe isso, ou
// etapa que terminou em erro) simplesmente não aparece aqui. Reaproveitada
// por cli.ts (history --last) além do relatório markdown — mesma lógica de
// formatação, sem duplicar.
export function usageLine(usage: AgentUsage | undefined): string | undefined {
  if (!usage) return undefined;

  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`entrada ${usage.inputTokens}`);
  if (usage.outputTokens !== undefined) parts.push(`saída ${usage.outputTokens}`);
  if (usage.cacheReadTokens !== undefined) parts.push(`cache leitura ${usage.cacheReadTokens}`);
  if (usage.cacheCreationTokens !== undefined) parts.push(`cache criação ${usage.cacheCreationTokens}`);
  if (usage.thinkingTokens !== undefined) parts.push(`raciocínio ${usage.thinkingTokens}`);
  if (parts.length === 0 && usage.costUsd === undefined) return undefined;

  const tokens = parts.length > 0 ? `tokens: ${parts.join(" · ")}` : "";
  const cost = usage.costUsd !== undefined ? `custo ${formatUsdCost(usage.costUsd)}` : "";
  return [tokens, cost].filter(Boolean).join(" · ");
}

function retriesTable(step: HistoryStep): string[] {
  if (!step.retries || step.retries.length === 0) return [];

  const rows = step.retries.map(
    (retry) => `| ${retry.attempt} | ${retry.kind} | ${retry.message.replace(/\|/g, "\\|")} | ${retry.delayMs}ms |`,
  );
  return [
    "",
    "**Tentativas antes do resultado final:**",
    "",
    "| # | Tipo | Mensagem | Backoff até a próxima |",
    "| --- | --- | --- | --- |",
    ...rows,
  ];
}

function stepSection(step: HistoryStep, index: number): string[] {
  const handoff = step.fedByStepId ? ` — alimentada pela etapa #${step.fedByStepId}` : "";
  const lines: string[] = [`## Etapa ${index + 1} — ${step.agent} (${formatDuration(step.durationMs)})${handoff}`, ""];

  lines.push("**Prompt:**", "", "```", step.prompt, "```", "");

  const usage = usageLine(step.usage);
  if (usage) lines.push(usage, "");

  if (step.error) {
    lines.push(`**Erro:** ${step.error}`, "");
  } else {
    lines.push("**Output:**", "", "```", step.output, "```", "");
  }

  lines.push(...retriesTable(step));

  return lines;
}

// Custo total só soma etapas que de fato reportaram `costUsd` — hoje só o
// claude expõe isso (ver AgentUsage/CLAUDE.md). Retorna undefined quando
// NENHUMA etapa tem custo, pra quem chama decidir se vale a pena mostrar
// um aviso de "custo parcial" quando SÓ ALGUMAS etapas têm. Reaproveitada
// por cli.ts (history --last) além do relatório markdown.
export function totalCostUsd(steps: HistoryStep[]): { total: number; stepsWithCost: number } | undefined {
  const withCost = steps.filter((step) => step.usage?.costUsd !== undefined);
  if (withCost.length === 0) return undefined;

  const total = withCost.reduce((sum, step) => sum + (step.usage!.costUsd ?? 0), 0);
  return { total, stepsWithCost: withCost.length };
}

export function buildMarkdownReport(run: HistoryRun): string {
  const lines: string[] = [`# Relatório de execução — ${run.task}`, ""];

  lines.push(`- **Run ID:** \`${run.id}\``);
  lines.push(`- **Início:** ${run.startedAt}`);
  lines.push(`- **Fim:** ${run.finishedAt ?? "(execução não finalizada)"}`);
  lines.push(`- **Etapas:** ${run.steps.length}`);

  const cost = totalCostUsd(run.steps);
  if (cost) {
    const partial = cost.stepsWithCost < run.steps.length;
    const note = partial ? ` (${cost.stepsWithCost}/${run.steps.length} etapas reportaram custo — parcial, não é o custo total do run)` : "";
    lines.push(`- **Custo total reportado:** ${formatUsdCost(cost.total)}${note}`);
  }

  lines.push("");

  for (const [index, step] of run.steps.entries()) {
    lines.push(...stepSection(step, index));
  }

  return lines.join("\n").trimEnd() + "\n";
}
