import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import {
  canWriteContract,
  createContractBoard,
  installContractHelper,
  readContractBoard,
  type ContractBoard,
} from "./contracts.js";
import { MAILBOX_DIRECTORY } from "./mailbox.js";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

function board(entries: ContractBoard["entries"]): ContractBoard {
  return { version: 1, entries };
}

const entry = (value: string, owner: string) => ({ value, owner, at: "2026-01-01T00:00:00.000Z" });

describe("canWriteContract", () => {
  it("chave nova é livre", () => {
    expect(canWriteContract(board({}), "auth.token", "JWT", "api")).toEqual({ ok: true });
  });

  it("o dono pode reescrever a própria chave", () => {
    const current = board({ "auth.token": entry("JWT", "api") });
    expect(canWriteContract(current, "auth.token", "PASETO", "api")).toEqual({ ok: true });
  });

  // O caso que o quadro existe pra impedir: dois agentes definindo a mesma
  // interface de formas divergentes, cada um seguindo em frente sem saber.
  it("recusa quem tenta redefinir a chave de outra subtarefa", () => {
    const current = board({ "auth.token": entry("JWT", "api") });
    const result = canWriteContract(current, "auth.token", "PASETO", "web");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("api");
      expect(result.reason).toContain("JWT");
    }
  });

  it("reafirmar o mesmo valor é idempotente, não conflito", () => {
    const current = board({ "auth.token": entry("JWT", "api") });
    expect(canWriteContract(current, "auth.token", "JWT", "web")).toEqual({ ok: true });
  });
});

describe("utilitário de contratos em processos reais", () => {
  function fixture(tasks: string[]) {
    const root = mkdtempSync(join(tmpdir(), "orquestrador-contracts-")); roots.push(root);
    const teamDirectory = join(root, "team");
    mkdirSync(teamDirectory, { recursive: true });
    createContractBoard(teamDirectory);
    const helpers = new Map(tasks.map((id) => {
      const worktree = join(root, id);
      mkdirSync(join(worktree, MAILBOX_DIRECTORY), { recursive: true });
      installContractHelper(worktree, teamDirectory, id);
      return [id, join(worktree, MAILBOX_DIRECTORY, "contracts.cjs")];
    }));
    return { teamDirectory, helpers };
  }

  const run = (helper: string, args: string[]) =>
    execa(process.execPath, [helper, ...args], { reject: false });

  it("registra um contrato e o torna visível para outra subtarefa", async () => {
    const { teamDirectory, helpers } = fixture(["api", "web"]);
    await run(helpers.get("api")!, ["set", "auth.token", "JWT com claim sub"]);

    const { stdout } = await run(helpers.get("web")!, ["get", "auth.token"]);
    expect(stdout).toContain("JWT com claim sub");
    expect(stdout).toContain('"owner": "api"');
    expect(readContractBoard(teamDirectory).entries["auth.token"]?.owner).toBe("api");
  });

  it("recusa a segunda subtarefa que tenta divergir, com o valor atual na mensagem", async () => {
    const { helpers } = fixture(["api", "web"]);
    await run(helpers.get("api")!, ["set", "auth.token", "JWT"]);

    const conflito = await run(helpers.get("web")!, ["set", "auth.token", "PASETO"]);
    expect(conflito.exitCode).toBe(1);
    expect(conflito.stderr).toContain("já foi definida por api");
    expect(conflito.stderr).toContain("JWT");
  });

  // O id do dono é embutido na geração do helper, por worktree — um agente
  // não consegue se passar por outro mexendo no ambiente.
  it("a identidade do escritor não vem do ambiente", async () => {
    const { helpers } = fixture(["api", "web"]);
    await execa(process.execPath, [helpers.get("web")!, "set", "rota.login", "POST /login"], {
      env: { ORQUESTRADOR_TASK_ID: "api" },
    });
    const { stdout } = await run(helpers.get("api")!, ["get", "rota.login"]);
    expect(stdout).toContain('"owner": "web"');
  });

  // N agentes escrevem no MESMO arquivo ao mesmo tempo, de processos
  // separados: sem o lockfile, escritas se perdiam por last-write-wins.
  it("escritas concorrentes de processos distintos não se perdem", async () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const { teamDirectory, helpers } = fixture(ids);

    await Promise.all(ids.map((id) => run(helpers.get(id)!, ["set", `chave.${id}`, `valor de ${id}`])));

    const entries = readContractBoard(teamDirectory).entries;
    expect(Object.keys(entries).sort()).toEqual(ids.map((id) => `chave.${id}`));
    for (const id of ids) expect(entries[`chave.${id}`]?.owner).toBe(id);
  });

  it("list mostra o quadro inteiro e get avisa quando a chave não existe", async () => {
    const { helpers } = fixture(["api"]);
    const vazio = await run(helpers.get("api")!, ["get", "nada"]);
    expect(vazio.stdout).toContain("não definida");

    await run(helpers.get("api")!, ["set", "x", "1"]);
    const lista = await run(helpers.get("api")!, ["list"]);
    expect(lista.stdout).toContain('"x"');
  });

  it("rejeita uso inválido sem gravar nada", async () => {
    const { teamDirectory, helpers } = fixture(["api"]);
    expect((await run(helpers.get("api")!, ["set", "sem-valor"])).exitCode).toBe(1);
    expect((await run(helpers.get("api")!, ["foo"])).exitCode).toBe(1);
    expect(Object.keys(readContractBoard(teamDirectory).entries)).toEqual([]);
  });
});
