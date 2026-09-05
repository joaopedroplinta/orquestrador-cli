import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentName, AgentRetryAttempt, AgentUsage, HistoryRun, HistoryStep } from "../types.js";

const DB_DIR = join(homedir(), ".orquestrador");
const DB_PATH = join(DB_DIR, "history.db");

let db: Database.Database | undefined;

function getDb(): Database.Database {
  if (db) return db;

  mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      task TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id),
      agent TEXT NOT NULL,
      prompt TEXT NOT NULL,
      output TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      error TEXT,
      fed_by_step_id INTEGER REFERENCES steps(id),
      retries TEXT,
      usage TEXT
    );
  `);
  ensureColumn(db, "retries");
  ensureColumn(db, "usage");
  return db;
}

// Sem sistema de migração de verdade neste projeto (ver CLAUDE.md); pra não
// quebrar bancos existentes (~/.orquestrador/history.db) só por causa de uma
// coluna nova, adiciona ela em bancos antigos em vez de exigir apagar o
// arquivo — `CREATE TABLE IF NOT EXISTS` sozinho não altera uma tabela que
// já existia sem a coluna.
function ensureColumn(database: Database.Database, column: string): void {
  const columns = database.prepare("PRAGMA table_info(steps)").all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE steps ADD COLUMN ${column} TEXT`);
  }
}

interface RunRow {
  id: string;
  task: string;
  started_at: string;
  finished_at: string | null;
}

interface StepRow {
  id: number;
  run_id: string;
  agent: AgentName;
  prompt: string;
  output: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  error: string | null;
  fed_by_step_id: number | null;
  retries: string | null;
  usage: string | null;
}

function rowToStep(row: StepRow): HistoryStep {
  return {
    id: row.id,
    runId: row.run_id,
    agent: row.agent,
    prompt: row.prompt,
    output: row.output,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    error: row.error ?? undefined,
    fedByStepId: row.fed_by_step_id ?? undefined,
    retries: row.retries ? (JSON.parse(row.retries) as AgentRetryAttempt[]) : undefined,
    usage: row.usage ? (JSON.parse(row.usage) as AgentUsage) : undefined,
  };
}

function hydrateRun(row: RunRow): HistoryRun {
  return {
    id: row.id,
    task: row.task,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    steps: (
      getDb().prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY id ASC").all(row.id) as StepRow[]
    ).map(rowToStep),
  };
}

export function startRun(task: string): string {
  const id = randomUUID();
  getDb()
    .prepare("INSERT INTO runs (id, task, started_at) VALUES (?, ?, ?)")
    .run(id, task, new Date().toISOString());
  return id;
}

export function finishRun(runId: string): void {
  getDb()
    .prepare("UPDATE runs SET finished_at = ? WHERE id = ?")
    .run(new Date().toISOString(), runId);
}

export function logStep(runId: string, step: Omit<HistoryStep, "id" | "runId">): number {
  const result = getDb()
    .prepare(
      `INSERT INTO steps (run_id, agent, prompt, output, started_at, finished_at, duration_ms, error, fed_by_step_id, retries, usage)
       VALUES (@runId, @agent, @prompt, @output, @startedAt, @finishedAt, @durationMs, @error, @fedByStepId, @retries, @usage)`,
    )
    .run({
      runId,
      error: null,
      fedByStepId: null,
      ...step,
      retries: step.retries && step.retries.length > 0 ? JSON.stringify(step.retries) : null,
      usage: step.usage ? JSON.stringify(step.usage) : null,
    });
  return Number(result.lastInsertRowid);
}

export function listRuns(limit = 20): HistoryRun[] {
  const runs = getDb()
    .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?")
    .all(limit) as RunRow[];

  return runs.map(hydrateRun);
}

export function getLastRun(): HistoryRun | undefined {
  return listRuns(1)[0];
}

// Aceita tanto o id completo (UUID) quanto o prefixo de 8 caracteres
// mostrado em `history` (mesma convenção de hash curto do git) — tenta
// bater exato primeiro, senão cai pro prefixo, pegando a execução mais
// recente em caso de ambiguidade.
export function getRunById(id: string): HistoryRun | undefined {
  const database = getDb();
  const exact = database.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
  const row =
    exact ??
    (database
      .prepare("SELECT * FROM runs WHERE id LIKE ? ORDER BY started_at DESC LIMIT 1")
      .get(`${id}%`) as RunRow | undefined);

  return row ? hydrateRun(row) : undefined;
}
