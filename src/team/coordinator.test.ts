import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentName, AgentRunOptions, AgentRunner } from "../types.js";
import { cleanupTeam, isTeamInterrupted, readTeam, recoverTeam, runTeam, sendToTeam } from "./coordinator.js";
import { git } from "./worktrees.js";
import { writeJson } from "./mailbox.js";
import type { TeamPlan } from "./plan.js";
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "orquestrador-team-")); roots.push(root);
  await execa("git", ["init", join(root, "repo")]);
  const repo = join(root, "repo");
  writeFileSync(join(repo, "base.txt"), "base\n");
  await git(repo, ["add", "."]); await git(repo, ["commit", "-m", "initial"]);
  return { repo, directory: join(root, "teams") };
}
function result(agent: AgentName, options: AgentRunOptions, output = "concluído") {
  return { agent, prompt: options.prompt, output, durationMs: 1, startedAt: "2026-09-06T00:00:00Z", finishedAt: "2026-09-06T00:00:01Z" };
}
const unused: AgentRunner = async () => { throw new Error("agente não esperado"); };
const plan: TeamPlan = { tasks: [
  { id: "api", agent: "codex", task: "API", dependsOn: [] },
  { id: "ui", agent: "claude", task: "UI", dependsOn: [] },
  { id: "verify", agent: "antigravity", task: "verificar", dependsOn: ["api", "ui"] },
] };

describe("coordenador com Git real", () => {
  it("executa em paralelo, entrega mensagens durante a execução, integra dependências e preserva a origem", async () => {
    const { repo, directory } = await fixture();
    const base = await git(repo, ["rev-parse", "HEAD"]);
    let started = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    let active = 0, maxActive = 0;
    const worker = (agent: AgentName, file: string): AgentRunner => async (options) => {
      active++; maxActive = Math.max(maxActive, active);
      if (++started === 2) release();
      await bothStarted;
      if (agent === "codex") {
        await execa(process.execPath, [".orquestrador-team/mailbox.cjs", "send", "ui", "API usa /login"], { cwd: options.cwd });
      } else {
        // O agente consulta sua caixa enquanto ambos continuam rodando.
        let received = false;
        for (let i = 0; i < 30 && !received; i++) {
          const { stdout } = await execa(process.execPath, [".orquestrador-team/mailbox.cjs", "inbox"], { cwd: options.cwd });
          received = JSON.parse(stdout).some((m: { text: string }) => m.text === "API usa /login");
          if (!received) await new Promise((resolve) => setTimeout(resolve, 30));
        }
        expect(received).toBe(true);
      }
      writeFileSync(join(options.cwd!, file), `${file}\n`);
      active--;
      return result(agent, options, `${file} pronto`);
    };
    const verify: AgentRunner = async (options) => {
      expect(readFileSync(join(options.cwd!, "api.txt"), "utf8")).toBe("api.txt\n");
      expect(readFileSync(join(options.cwd!, "ui.txt"), "utf8")).toBe("ui.txt\n");
      expect(options.context).toContain("api.txt pronto");
      expect(options.context).toContain("ui.txt pronto");
      return result("antigravity", options);
    };
    const state = await runTeam({ task: "criar login", cwd: repo, directory, plan, concurrency: 2,
      runners: { codex: worker("codex", "api.txt"), claude: worker("claude", "ui.txt"), antigravity: verify } });
    expect(state.status, state.error ?? JSON.stringify(state.tasks)).toBe("completed");
    expect(maxActive).toBe(2);
    expect(state.messages).toEqual([expect.objectContaining({ from: "api", to: "ui", text: "API usa /login" })]);
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(base);
    expect(await git(repo, ["status", "--porcelain"])).toBe("");
    expect(readFileSync(join(state.integration!.worktree, "api.txt"), "utf8")).toBe("api.txt\n");
    expect(await git(state.integration!.worktree, ["ls-files", ".orquestrador-team"])).toBe("");
    expect(readTeam(state.id, directory).finishedAt).toBeDefined();
  }, 15_000);

  it("falha parcial bloqueia dependentes, mas permite terminar tarefas independentes", async () => {
    const { repo, directory } = await fixture();
    const verify = vi.fn(unused);
    const state = await runTeam({ task: "teste", cwd: repo, directory, plan, concurrency: 1,
      runners: { codex: async () => { throw new Error("API falhou"); }, claude: async (o) => result("claude", o), antigravity: verify } });
    expect(state.status).toBe("partial");
    expect(state.tasks.map((t) => t.status)).toEqual(["failed", "completed", "blocked"]);
    expect(verify).not.toHaveBeenCalled();
    expect(state.integration?.merged).toEqual(["ui"]);
  });

  it("preserva conflitos na integração sem modificar o checkout original", async () => {
    const { repo, directory } = await fixture();
    const worker = (agent: AgentName): AgentRunner => async (options) => {
      writeFileSync(join(options.cwd!, "base.txt"), `${agent}\n`);
      return result(agent, options);
    };
    const state = await runTeam({ task: "teste", cwd: repo, directory, plan: { tasks: plan.tasks.slice(0, 2) },
      runners: { codex: worker("codex"), claude: worker("claude"), antigravity: unused } });
    expect(state.status).toBe("conflict");
    expect(state.integration?.conflictTask).toBe("ui");
    expect(await git(state.integration!.worktree, ["diff", "--name-only", "--diff-filter=U"])).toBe("base.txt");
    expect(readFileSync(join(repo, "base.txt"), "utf8")).toBe("base\n");
  });

  // Antes, o primeiro conflito fazia `return` e o trabalho das tarefas que
  // mergeariam limpo era perdido de vista. Agora a integração segue e só o
  // conflito real fica em aberto pra resolução manual.
  it("integra as tarefas que fecham limpo mesmo quando outra conflita", async () => {
    const { repo, directory } = await fixture();
    // api e ui disputam base.txt; solo escreve num arquivo só dele.
    const disputa = (agent: AgentName): AgentRunner => async (options) => {
      writeFileSync(join(options.cwd!, "base.txt"), `${agent}\n`);
      return result(agent, options);
    };
    const isolada: AgentRunner = async (options) => {
      writeFileSync(join(options.cwd!, "solo.txt"), "sozinho\n");
      return result("antigravity", options);
    };
    const state = await runTeam({
      task: "teste", cwd: repo, directory,
      plan: { tasks: [
        { id: "api", agent: "codex", task: "API", dependsOn: [] },
        { id: "ui", agent: "claude", task: "UI", dependsOn: [] },
        { id: "solo", agent: "antigravity", task: "isolada", dependsOn: [] },
      ] },
      runners: { codex: disputa("codex"), claude: disputa("claude"), antigravity: isolada },
    });

    expect(state.status).toBe("conflict");
    // A tarefa sem conflito entrou na branch de integração em vez de sumir.
    expect(state.integration?.merged).toContain("solo");
    expect(existsSync(join(state.integration!.worktree, "solo.txt"))).toBe(true);
    // E o conflito real continua em aberto na worktree, pra resolver na mão.
    expect(state.integration?.conflicts.map((c) => c.task)).toEqual(["ui"]);
    expect(state.integration?.conflicts[0]?.files).toEqual(["base.txt"]);
    expect(await git(state.integration!.worktree, ["diff", "--name-only", "--diff-filter=U"])).toBe("base.txt");
    expect(readFileSync(join(repo, "base.txt"), "utf8")).toBe("base\n");
  });

  it("cancela processos ativos sem iniciar tarefas pendentes", async () => {
    const { repo, directory } = await fixture();
    const controller = new AbortController();
    const codex: AgentRunner = async (o) => { controller.abort(); throw new Error("cancelado"); };
    const claude = vi.fn(unused);
    const state = await runTeam({ task: "teste", cwd: repo, directory, plan, concurrency: 1, signal: controller.signal,
      runners: { codex, claude, antigravity: unused } });
    expect(state.status).toBe("cancelled");
    expect(claude).not.toHaveBeenCalled();
    expect(state.integration).toBeUndefined();
    expect(state.finishedAt).toBeDefined();
  });

  it("recusa checkout sujo antes de chamar modelos", async () => {
    const { repo, directory } = await fixture();
    writeFileSync(join(repo, "base.txt"), "trabalho não salvo\n");
    await expect(runTeam({ task: "teste", cwd: repo, directory, plan })).rejects.toThrow("repositório limpo");
    expect(readFileSync(join(repo, "base.txt"), "utf8")).toBe("trabalho não salvo\n");
  });

  it("planeja em worktree separada e aceita mensagens do usuário", async () => {
    const { repo, directory } = await fixture();
    let teamId = "";
    const claude: AgentRunner = async (o) => {
      expect(o.cwd).not.toBe(repo);
      return result("claude", o, JSON.stringify({ tasks: [plan.tasks[0]] }));
    };
    const codex: AgentRunner = async (o) => {
      sendToTeam(teamId, "api", "use JWT", directory);
      return result("codex", o);
    };
    const state = await runTeam({ task: "teste", cwd: repo, directory, agents: ["claude", "codex"],
      onEvent: (event) => { if (event.startsWith("Equipe ")) teamId = event.split(" ")[1]!.replace(":", ""); },
      runners: { claude, codex, antigravity: unused } });
    expect(state.status).toBe("completed");
    expect(state.plannerResult).toBeDefined();
    expect(state.messages).toEqual([expect.objectContaining({ from: "user", to: "api", text: "use JWT" })]);
    expect(() => sendToTeam(state.id, "api", "tarde", directory)).toThrow("não está executando");
  });

  it("executa o bootstrap sem shell antes de chamar a subtarefa", async () => {
    const { repo, directory } = await fixture();
    const worker: AgentRunner = async (options) => {
      expect(readFileSync(join(options.cwd!, "bootstrap.txt"), "utf8")).toBe("pronto\n");
      return result("codex", options);
    };
    const state = await runTeam({
      task: "teste", cwd: repo, directory, plan: { tasks: [plan.tasks[0]!] },
      bootstrap: [process.execPath, "-e", "require('node:fs').writeFileSync('bootstrap.txt', 'pronto\\n')"],
      runners: { codex: worker, claude: unused, antigravity: unused },
    });
    expect(state.status).toBe("completed");
  });

  it("limpa worktrees concluídas sem apagar alterações manuais e só força quando pedido", async () => {
    const { repo, directory } = await fixture();
    const state = await runTeam({ task: "teste", cwd: repo, directory, plan: { tasks: [plan.tasks[0]!] },
      runners: { codex: async (o) => result("codex", o), claude: unused, antigravity: unused } });
    writeFileSync(join(state.tasks[0]!.worktree, "manual.txt"), "preservar\n");
    const safe = await cleanupTeam(state.id, { directory });
    expect(safe.skippedWorktrees).toEqual(expect.arrayContaining([expect.objectContaining({ path: state.tasks[0]!.worktree })]));
    expect(existsSync(state.tasks[0]!.worktree)).toBe(true);
    const forced = await cleanupTeam(state.id, { directory, force: true });
    expect(forced.removedWorktrees).toContain(state.tasks[0]!.worktree);
    expect(existsSync(state.tasks[0]!.worktree)).toBe(false);
    expect(existsSync(state.integration!.worktree)).toBe(false);
  });
});

it("respeita limite de uma tarefa ativa mesmo com várias prontas", async () => {
  const { repo, directory } = await fixture();
  let active = 0, peak = 0;
  const worker = (agent: AgentName): AgentRunner => async (o) => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    return result(agent, o);
  };
  const state = await runTeam({ task: "teste", cwd: repo, directory, concurrency: 1,
    plan: { tasks: plan.tasks.slice(0, 2) }, runners: { codex: worker("codex"), claude: worker("claude"), antigravity: unused } });
  expect(state.status).toBe("completed");
  expect(peak).toBe(1);
});

it("falha no planejamento fica registrada sem disparar executores", async () => {
  const { repo, directory } = await fixture();
  const codex = vi.fn(unused);
  const state = await runTeam({ task: "teste", cwd: repo, directory,
    runners: { claude: async (o) => result("claude", o, "plano inválido"), codex, antigravity: unused } });
  expect(state.status).toBe("failed");
  expect(state.error).toContain("JSON válido");
  expect(codex).not.toHaveBeenCalled();
  expect(readTeam(state.id, directory).plannerResult).toBeDefined();
});

it("recupera uma equipe interrompida sem executar ou apagar worktrees", () => {
  const root = mkdtempSync(join(tmpdir(), "orquestrador-recover-")); roots.push(root);
  const directory = join(root, "teams");
  const id = "12345678-1234-1234-1234-123456789abc";
  const teamDirectory = join(directory, id);
  const worktree = join(teamDirectory, "api");
  mkdirSync(teamDirectory, { recursive: true });
  writeJson(join(teamDirectory, "state.json"), {
    id, task: "teste", root, base: "abc", directory: teamDirectory, status: "running", startedAt: "2026-01-01T00:00:00.000Z", ownerPid: 999_999_999,
    tasks: [{ id: "api", agent: "codex", task: "API", dependsOn: [], status: "running", worktree, branch: `orquestrador/${id}/api` }], messages: [],
  });
  expect(isTeamInterrupted(readTeam(id, directory))).toBe(true);
  const state = recoverTeam(id, directory);
  expect(state.status).toBe("cancelled");
  expect(state.tasks[0]?.status).toBe("cancelled");
  expect(readTeam(id, directory).recoveredAt).toBeDefined();
});
