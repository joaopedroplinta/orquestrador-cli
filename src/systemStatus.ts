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
  nodeVersion: string;
  historyRunsCount: number;
  claude: CliHealth;
  antigravity: CliHealth;
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

  const [gitBranch, claudeHealth, agyHealth] = await Promise.all([
    getGitBranch(cwd),
    checkCli("claude"),
    checkCli("agy"),
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
    nodeVersion: process.version,
    historyRunsCount,
    claude: claudeHealth,
    antigravity: agyHealth,
  };
}
