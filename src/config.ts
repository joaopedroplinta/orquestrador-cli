import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isAgentName } from "./agents/registry.js";
import type { AgentName, RoutingStrategy } from "./types.js";

export const CONFIG_FILENAME = ".orquestradorrc";

export interface TeamConfig {
  /** Agentes disponíveis para `team run` quando a flag --agents não for usada. */
  agents?: AgentName[];
  concurrency?: number;
  timeoutMs?: number;
  /** Programa e argumentos, sem shell, executados em cada worktree antes do agente. */
  bootstrap?: string[];
  bootstrapTimeoutMs?: number;
}

/** Tudo opcional — cada projeto configura só o que quiser sobrescrever do default global. */
export interface OrquestradorConfig {
  /** Equivalente a --agent: força esse agente pra toda tarefa rodada neste projeto. */
  agent?: AgentName;
  /** Equivalente a --routing. */
  routing?: RoutingStrategy;
  /** Equivalente a --auto. */
  auto?: boolean;
  /** Máximo de tentativas de retry por etapa (não conta a tentativa inicial). */
  maxRetries?: number;
  /** Base do backoff exponencial em ms. */
  retryBaseDelayMs?: number;
  /** Defaults do modo `team`. */
  team?: TeamConfig;
}

function isRoutingStrategyValue(value: unknown): value is RoutingStrategy {
  return value === "keyword" || value === "classify";
}

// Cada campo é validado (e descartado, com aviso) individualmente — um campo
// ruim não invalida o arquivo inteiro, só aquele campo.
export function parseOrquestradorConfig(raw: string): { config: OrquestradorConfig; warnings: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config: {}, warnings: ["JSON inválido — ignorando o arquivo inteiro."] };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { config: {}, warnings: ["esperava um objeto JSON no nível mais alto — ignorando o arquivo inteiro."] };
  }

  const obj = parsed as Record<string, unknown>;
  const warnings: string[] = [];
  const config: OrquestradorConfig = {};

  if ("agent" in obj) {
    if (typeof obj.agent === "string" && isAgentName(obj.agent)) config.agent = obj.agent;
    else warnings.push(`"agent": ${JSON.stringify(obj.agent)} inválido (use "claude", "antigravity" ou "codex") — ignorado.`);
  }
  if ("routing" in obj) {
    if (isRoutingStrategyValue(obj.routing)) config.routing = obj.routing;
    else warnings.push(`"routing": ${JSON.stringify(obj.routing)} inválido (use "keyword" ou "classify") — ignorado.`);
  }
  if ("auto" in obj) {
    if (typeof obj.auto === "boolean") config.auto = obj.auto;
    else warnings.push(`"auto": ${JSON.stringify(obj.auto)} inválido (use true ou false) — ignorado.`);
  }
  if ("maxRetries" in obj) {
    if (typeof obj.maxRetries === "number" && Number.isInteger(obj.maxRetries) && obj.maxRetries >= 0) {
      config.maxRetries = obj.maxRetries;
    } else {
      warnings.push(`"maxRetries": ${JSON.stringify(obj.maxRetries)} inválido (use um inteiro >= 0) — ignorado.`);
    }
  }
  if ("retryBaseDelayMs" in obj) {
    if (typeof obj.retryBaseDelayMs === "number" && Number.isInteger(obj.retryBaseDelayMs) && obj.retryBaseDelayMs > 0) {
      config.retryBaseDelayMs = obj.retryBaseDelayMs;
    } else {
      warnings.push(`"retryBaseDelayMs": ${JSON.stringify(obj.retryBaseDelayMs)} inválido (use um inteiro > 0) — ignorado.`);
    }
  }
  if ("team" in obj) {
    if (typeof obj.team !== "object" || obj.team === null || Array.isArray(obj.team)) {
      warnings.push('"team" inválido (use um objeto) — ignorado.');
    } else {
      const team = obj.team as Record<string, unknown>;
      const parsedTeam: TeamConfig = {};
      if ("agents" in team) {
        if (Array.isArray(team.agents) && team.agents.length > 0 && team.agents.length <= 3
          && team.agents.every((agent) => typeof agent === "string" && isAgentName(agent))
          && new Set(team.agents).size === team.agents.length) {
          parsedTeam.agents = team.agents as AgentName[];
        } else warnings.push('"team.agents" inválido (use uma lista sem repetição de claude, antigravity e/ou codex) — ignorado.');
      }
      for (const [key, target] of [["concurrency", "concurrency"], ["timeoutMs", "timeoutMs"], ["bootstrapTimeoutMs", "bootstrapTimeoutMs"]] as const) {
        const value = team[key];
        if (!(key in team)) continue;
        if (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && (key !== "concurrency" || value <= 12)) {
          parsedTeam[target] = value;
        } else warnings.push(`"team.${key}" inválido (use ${key === "concurrency" ? "um inteiro entre 1 e 12" : "um inteiro positivo"}) — ignorado.`);
      }
      if ("bootstrap" in team) {
        if (Array.isArray(team.bootstrap) && team.bootstrap.length > 0 && team.bootstrap.length <= 32
          && team.bootstrap.every((part) => typeof part === "string" && part.trim().length > 0 && !part.includes("\0"))) {
          parsedTeam.bootstrap = team.bootstrap as string[];
        } else warnings.push('"team.bootstrap" inválido (use uma lista não vazia de argumentos) — ignorado.');
      }
      if (Object.keys(parsedTeam).length > 0) config.team = parsedTeam;
    }
  }
  return { config, warnings };
}

export interface DiscoveredConfig {
  /** Diretório onde o .orquestradorrc foi encontrado — é o "raiz do projeto" pra filtro de histórico por cwd. */
  dir: string;
  path: string;
  config: OrquestradorConfig;
  warnings: string[];
}

// Mesma ideia de descoberta que o Claude Code usa pro CLAUDE.md local: começa
// no diretório atual e sobe um nível de cada vez até achar o arquivo ou
// chegar na raiz do sistema de arquivos. Pega o PRIMEIRO que encontrar (mais
// próximo do cwd vence, não uma fusão de vários níveis).
export function discoverProjectConfig(startDir: string = process.cwd()): DiscoveredConfig | undefined {
  let dir = resolve(startDir);

  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate, "utf8");
      const { config, warnings } = parseOrquestradorConfig(raw);
      return { dir, path: candidate, config, warnings };
    }

    const parent = dirname(dir);
    if (parent === dir) return undefined; // chegou na raiz do FS sem achar nada
    dir = parent;
  }
}

/**
 * Prioridade em cada campo: valor de CLI (`cliValue`) > `.orquestradorrc` do
 * projeto > default global (aplicado mais embaixo, em `pipeline.ts`/
 * `agents/shared.ts` — aqui só devolve `undefined` quando nenhum dos dois
 * primeiros níveis decidiu nada, e quem chama já sabe tratar isso como "usa
 * o default de sempre").
 */
export function resolveConfigValue<T>(cliValue: T | undefined, projectValue: T | undefined): T | undefined {
  return cliValue ?? projectValue;
}
