import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TeamStore } from "./persistence.js";

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function store(debounceMs = 10) {
  const directory = mkdtempSync(join(tmpdir(), "orquestrador-store-"));
  roots.push(directory);
  return { directory, store: new TeamStore(directory, { debounceMs }) };
}

function readState(directory: string): unknown {
  return JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
}

function readEvents(directory: string): string[] {
  return readFileSync(join(directory, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { event: string }).event);
}

describe("TeamStore", () => {
  it("não toca no disco antes do debounce vencer", async () => {
    const { directory, store: s } = store(1000);
    s.save({ status: "running" });
    expect(existsSync(join(directory, "state.json"))).toBe(false);
  });

  it("flush() força a escrita pendente e espera o disco", async () => {
    const { directory, store: s } = store(1000);
    s.save({ status: "running" });
    await s.flush();
    expect(readState(directory)).toEqual({ status: "running" });
  });

  // O ponto do debounce: N salvamentos na janela viram UMA escrita, e o que
  // sobrevive é o último estado — não um intermediário.
  it("salvamentos seguidos dentro da janela viram uma escrita só, com o último valor", async () => {
    const { directory, store: s } = store(1000);
    s.save({ n: 1 });
    s.save({ n: 2 });
    s.save({ n: 3 });
    await s.flush();
    expect(readState(directory)).toEqual({ n: 3 });
  });

  it("saveNow() é durável na hora, sem esperar o debounce", async () => {
    const { directory, store: s } = store(60_000);
    await s.saveNow({ status: "running" });
    expect(readState(directory)).toEqual({ status: "running" });
  });

  it("eventos vão para um jsonl append-only, na ordem, sem reserializar o estado", async () => {
    const { directory, store: s } = store();
    s.appendEvent("primeiro");
    s.appendEvent("segundo");
    await s.flush();
    s.appendEvent("terceiro");
    await s.flush();
    expect(readEvents(directory)).toEqual(["primeiro", "segundo", "terceiro"]);
  });

  it("cada linha de evento carrega um timestamp ISO", async () => {
    const { directory, store: s } = store();
    s.appendEvent("x");
    await s.flush();
    const line = JSON.parse(readFileSync(join(directory, "events.jsonl"), "utf8").trim()) as { at: string };
    expect(new Date(line.at).toISOString()).toBe(line.at);
  });

  it("flush() é idempotente e não duplica eventos já gravados", async () => {
    const { directory, store: s } = store();
    s.appendEvent("único");
    await s.flush();
    await s.flush();
    await s.flush();
    expect(readEvents(directory)).toEqual(["único"]);
  });

  // Uma escrita que falha não pode virar unhandled rejection no meio da
  // execução da equipe; fica guardada e sai pelo flush, que já é aguardado.
  it("propaga falha de escrita pelo flush em vez de rejeitar sem dono", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orquestrador-store-"));
    roots.push(directory);
    const s = new TeamStore(directory, { debounceMs: 10 });
    s.save({ ok: true });
    await s.flush();
    rmSync(directory, { recursive: true, force: true }); // destino some
    s.save({ ok: false });
    await expect(s.flush()).rejects.toThrow();
  });

  it("uma falha guardada não contamina o flush seguinte", async () => {
    const { directory, store: s } = store();
    const gone = join(directory, "sumiu");
    const broken = new TeamStore(gone, { debounceMs: 10 });
    broken.save({ x: 1 });
    await expect(broken.flush()).rejects.toThrow();
    // Depois de propagado, o erro é limpo: um flush sem nada pendente passa.
    await expect(broken.flush()).resolves.toBeUndefined();
  });
});
