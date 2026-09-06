import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { MAILBOX_DIRECTORY } from "./mailbox.js";

const identity = ["-c", "user.name=Orquestrador", "-c", "user.email=orquestrador@localhost", "-c", "commit.gpgSign=false"];
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", [...identity, ...args], { cwd, timeout: 30_000 });
  return stdout.trim();
}

export async function inspectRepository(cwd: string): Promise<{ root: string; base: string }> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (await git(root, ["status", "--porcelain"])) {
    throw new Error("O modo team exige um repositório limpo. Faça commit das alterações antes de iniciar para todos partirem da mesma base.");
  }
  const base = await git(root, ["rev-parse", "HEAD"]);
  return { root, base };
}

export async function createWorktree(root: string, path: string, branch: string, base: string): Promise<void> {
  await git(root, ["worktree", "add", "-b", branch, path, base]);
}

export async function mergeCommit(path: string, commit: string): Promise<void> {
  await git(path, ["merge", "--no-edit", "--no-ff", commit]);
}

/** Arquivos alterados ou não rastreados, ignorando a infraestrutura efêmera da equipe. */
export async function worktreeChanges(path: string): Promise<string[]> {
  const output = await git(path, ["status", "--porcelain", "--untracked-files=all"]);
  return output
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.slice(3).replace(/^\"|\"$/g, "").startsWith(`${MAILBOX_DIRECTORY}/`));
}

/**
 * Remove uma worktree que já foi revisada. A caixa de mensagens é criada pelo
 * orquestrador e nunca faz parte do commit; removê-la antes permite usar o
 * `git worktree remove` normal, que continua protegendo alterações do usuário.
 */
export async function removeWorktree(root: string, path: string, force = false): Promise<void> {
  const mailbox = join(path, MAILBOX_DIRECTORY);
  if (existsSync(mailbox)) rmSync(mailbox, { recursive: true, force: true });
  await git(root, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
}

export async function deleteBranch(root: string, branch: string, force = false): Promise<void> {
  await git(root, ["branch", force ? "-D" : "-d", branch]);
}

/** Cria commits somente na worktree da tarefa, preservando o checkout original. */
export async function checkpoint(path: string, id: string): Promise<string> {
  await git(path, ["rm", "--cached", "-r", "--ignore-unmatch", "--", ".orquestrador-team"]);
  // A caixa de mensagens é infraestrutura local, nunca entra no resultado.
  await git(path, ["add", "-A", "--", ".", ":(exclude).orquestrador-team"]);
  if (await git(path, ["diff", "--cached", "--name-only"])) {
    await git(path, ["commit", "-m", `orquestrador: ${id}`]);
  }
  return git(path, ["rev-parse", "HEAD"]);
}
