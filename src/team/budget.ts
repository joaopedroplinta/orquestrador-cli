import type { AgentRunResult } from "../types.js";

/**
 * Limites de uma execução autônoma.
 *
 * O modo totalmente autônomo despacha N agentes sem supervisão humana; sem
 * um teto, um plano ruim (ou um agente em laço) queima tempo e dinheiro até
 * alguém perceber. Estourar um limite não mata o que já está rodando de
 * forma abrupta: cancela o lote, e o coordenador preserva worktrees e
 * resultados parciais como em qualquer cancelamento.
 */
export interface TeamBudget {
  /**
   * Teto de custo acumulado em USD.
   *
   * ATENÇÃO — cobertura parcial por natureza: só o claude reporta custo em
   * dólar (ver AgentUsage). Codex reporta tokens sem custo, antigravity não
   * reporta nada, e nós nunca inventamos um preço. Então este teto contabiliza
   * o gasto do claude e ignora o resto: é um piso do gasto real, não o total.
   * `wouldExceed` diz explicitamente quando a medição está incompleta.
   */
  maxCostUsd?: number;
  /** Teto de tempo de parede da equipe inteira. Diferente do custo, é medição completa. */
  maxDurationMs?: number;
}

export interface BudgetUsage {
  costUsd: number;
  /** Etapas cujo agente reportou custo — o denominador que torna `costUsd` interpretável. */
  reportingSteps: number;
  totalSteps: number;
  elapsedMs: number;
}

export function accumulate(results: Array<AgentRunResult | undefined>, elapsedMs: number): BudgetUsage {
  const steps = results.filter((result): result is AgentRunResult => result !== undefined);
  const withCost = steps.filter((step) => step.usage?.costUsd !== undefined);
  return {
    costUsd: withCost.reduce((total, step) => total + (step.usage!.costUsd ?? 0), 0),
    reportingSteps: withCost.length,
    totalSteps: steps.length,
    elapsedMs,
  };
}

/**
 * Devolve o motivo da parada, ou `undefined` para seguir. Texto pronto para o
 * usuário: quando o teto de custo é atingido, deixa claro que a medição cobre
 * só parte das etapas — esconder isso faria o número parecer o gasto total.
 */
export function budgetExceeded(budget: TeamBudget | undefined, usage: BudgetUsage): string | undefined {
  if (!budget) return undefined;
  if (budget.maxDurationMs !== undefined && usage.elapsedMs >= budget.maxDurationMs) {
    return `Tempo limite da equipe atingido (${Math.round(usage.elapsedMs / 1000)}s de ${Math.round(budget.maxDurationMs / 1000)}s).`;
  }
  if (budget.maxCostUsd !== undefined && usage.costUsd >= budget.maxCostUsd) {
    const cobertura = usage.reportingSteps === usage.totalSteps
      ? ""
      : ` — medido sobre ${usage.reportingSteps} de ${usage.totalSteps} etapas, porque só o claude reporta custo; o gasto real é maior`;
    return `Orçamento da equipe atingido (US$ ${usage.costUsd.toFixed(2)} de US$ ${budget.maxCostUsd.toFixed(2)})${cobertura}.`;
  }
  return undefined;
}

export function validateBudget(budget: TeamBudget | undefined): void {
  if (!budget) return;
  if (budget.maxCostUsd !== undefined && (!(budget.maxCostUsd > 0) || !Number.isFinite(budget.maxCostUsd))) {
    throw new Error("Orçamento deve ser um valor positivo em USD.");
  }
  if (budget.maxDurationMs !== undefined && (!Number.isSafeInteger(budget.maxDurationMs) || budget.maxDurationMs < 1)) {
    throw new Error("Tempo limite deve ser um inteiro positivo em ms.");
  }
}
