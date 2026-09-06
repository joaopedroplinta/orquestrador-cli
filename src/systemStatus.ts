import { execa } from "execa";
import { basename } from "node:path";
import { listRuns } from "./storage/history.js";

export interface CliHealth {
  installed: boolean;
  version?: string;
  error?: string;
}

export interface SystemStatus {
  cwd: string;
  projectName: string;
  gitBranch: string | null;
  gitClean: boolean | null;
  nodeVersion: string;
  historyRunsCount: number;
  codex: CliHealth;
  claude: CliHealth;
  antigravity: CliHealth;
}

export async function isGitClean(cwd: string = process.cwd()): Promise<boolean | null> {
  try {
    const { stdout } = await execa("git", ["status", "--porcelain"], { cwd, timeout: 2000 });
    return stdout.trim().length === 0;
  } catch {
    return null;
  }
}

export async function checkCli(command: string, args: string[] = ["--version"]): Promise<CliHealth> {
  try {
    const { stdout } = await execa(command, args, { timeout: 3000 });
    const firstLine = stdout.trim().split("\n")[0] || "instalado";
    return { installed: true, version: firstLine };
  } catch (error) {
    return {
      installed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Só responde se o diretório está sob controle de versão — usado para decidir
 * se vale avisar sobre edição concorrente sem isolamento (fora de um repo não
 * há worktree pra oferecer como alternativa).
 */
export async function isGitRepository(cwd: string = process.cwd()): Promise<boolean> {
  try {
    await execa("git", ["rev-parse", "--git-dir"], { cwd, timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

export async function getGitBranch(cwd: string = process.cwd()): Promise<string | null> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 2000 });
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

export async function getSystemStatus(): Promise<SystemStatus> {
  const cwd = process.cwd();
  const projectName = basename(cwd);

  const [gitBranch, gitClean, claudeHealth, agyHealth, codexHealth] = await Promise.all([
    getGitBranch(cwd),
    isGitClean(cwd),
    checkCli("claude"),
    checkCli("agy"),
    checkCli("codex"),
  ]);

  let historyRunsCount = 0;
  try {
    const runs = listRuns(100);
    historyRunsCount = runs.length;
  } catch {
    // SQLite pode falhar se inacessível ou mockado
  }

  return {
    cwd,
    projectName,
    gitBranch,
    gitClean,
    nodeVersion: process.version,
    historyRunsCount,
    codex: codexHealth,
    claude: claudeHealth,
    antigravity: agyHealth,
  };
}
