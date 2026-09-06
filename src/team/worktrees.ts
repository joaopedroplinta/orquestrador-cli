import { execa } from "execa";

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
