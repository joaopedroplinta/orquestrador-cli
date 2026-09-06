import { describe, expect, it, vi } from "vitest";
import { runScheduled, type SchedulerTask } from "./scheduler.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tarefa que resolve imediatamente com o próprio id. */
function ok(id: string, dependsOn?: string[]): SchedulerTask<string> {
  return { id, dependsOn, run: async () => id };
}

describe("runScheduled — validação", () => {
  it("rejeita concorrência inválida", async () => {
    await expect(runScheduled({ tasks: [ok("a")], concurrency: 0 })).rejects.toThrow("Concorrência");
    await expect(runScheduled({ tasks: [ok("a")], concurrency: 1.5 })).rejects.toThrow("Concorrência");
  });

  it("rejeita ids duplicados e dependência inexistente", async () => {
    await expect(runScheduled({ tasks: [ok("a"), ok("a")], concurrency: 1 })).rejects.toThrow("duplicados");
    await expect(runScheduled({ tasks: [ok("a", ["fantasma"])], concurrency: 1 })).rejects.toThrow("Dependência desconhecida");
  });
});

describe("runScheduled — ordem e dependências", () => {
  it("devolve os resultados na ordem de entrada, não na de conclusão", async () => {
    const tasks: SchedulerTask<string>[] = [
      { id: "lenta", run: async () => { await sleep(30); return "lenta"; } },
      { id: "rapida", run: async () => "rapida" },
    ];
    const outcomes = await runScheduled({ tasks, concurrency: 2 });
    expect(outcomes.map((o) => o.id)).toEqual(["lenta", "rapida"]);
  });

  it("só começa uma tarefa depois que todas as dependências concluíram", async () => {
    const order: string[] = [];
    const track = (id: string, dependsOn?: string[]): SchedulerTask<string> => ({
      id, dependsOn,
      run: async () => { order.push(id); await sleep(5); return id; },
    });
    await runScheduled({ tasks: [track("c", ["a", "b"]), track("a"), track("b")], concurrency: 3 });
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("a"));
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("b"));
  });

  it("entrega à dependente os valores já resolvidos das dependências", async () => {
    let received: Array<{ id: string; value: string }> = [];
    await runScheduled({
      concurrency: 2,
      tasks: [
        ok("a"),
        { id: "b", dependsOn: ["a"], run: async (ctx) => { received = ctx.dependencies; return "b"; } },
      ],
    });
    expect(received).toEqual([{ id: "a", value: "a" }]);
  });

  it("resolve uma cadeia declarada fora de ordem topológica", async () => {
    const outcomes = await runScheduled({
      tasks: [ok("terceira", ["segunda"]), ok("segunda", ["primeira"]), ok("primeira")],
      concurrency: 3,
    });
    expect(outcomes.every((o) => o.status === "completed")).toBe(true);
  });
});

describe("runScheduled — falhas isoladas", () => {
  it("uma tarefa que lança vira failed sem derrubar o lote", async () => {
    const boom: SchedulerTask<string> = { id: "boom", run: async () => { throw new Error("explodiu"); } };
    const outcomes = await runScheduled({ tasks: [boom, ok("ok")], concurrency: 2 });
    expect(outcomes[0]).toMatchObject({ id: "boom", status: "failed" });
    expect(outcomes[1]).toMatchObject({ id: "ok", status: "completed", value: "ok" });
  });

  it("uma dependência que falha bloqueia a dependente mas não as independentes", async () => {
    const boom: SchedulerTask<string> = { id: "boom", run: async () => { throw new Error("x"); } };
    const outcomes = await runScheduled({
      tasks: [boom, ok("dependente", ["boom"]), ok("independente")],
      concurrency: 3,
    });
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "blocked", "completed"]);
  });

  it("bloqueio se propaga por toda a cadeia", async () => {
    const boom: SchedulerTask<string> = { id: "a", run: async () => { throw new Error("x"); } };
    const outcomes = await runScheduled({
      tasks: [boom, ok("b", ["a"]), ok("c", ["b"])],
      concurrency: 3,
    });
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "blocked", "blocked"]);
  });
});

describe("runScheduled — teto de concorrência", () => {
  it("nunca ultrapassa o teto, e usa a folga de verdade", async () => {
    let ativos = 0;
    let pico = 0;
    const tasks = Array.from({ length: 8 }, (_, i): SchedulerTask<number> => ({
      id: `t${i}`,
      run: async () => {
        pico = Math.max(pico, ++ativos);
        await sleep(10);
        ativos--;
        return i;
      },
    }));
    await runScheduled({ tasks, concurrency: 3 });
    expect(pico).toBe(3);
  });

  it("concorrência 1 serializa completamente", async () => {
    let ativos = 0;
    let pico = 0;
    const tasks = Array.from({ length: 4 }, (_, i): SchedulerTask<number> => ({
      id: `t${i}`,
      run: async () => { pico = Math.max(pico, ++ativos); await sleep(5); ativos--; return i; },
    }));
    await runScheduled({ tasks, concurrency: 1 });
    expect(pico).toBe(1);
  });

  // O ganho real do paralelismo: 4 tarefas de 50ms com teto 4 terminam perto
  // de 50ms, não de 200ms. Margem generosa pra não ficar flaky em CI.
  it("tarefas independentes se sobrepõem de verdade no relógio de parede", async () => {
    const start = Date.now();
    const tasks = Array.from({ length: 4 }, (_, i): SchedulerTask<number> => ({
      id: `t${i}`,
      run: async () => { await sleep(50); return i; },
    }));
    await runScheduled({ tasks, concurrency: 4 });
    expect(Date.now() - start).toBeLessThan(150);
  });
});

describe("runScheduled — cancelamento", () => {
  it("um sinal já abortado cancela tudo sem rodar nada", async () => {
    const run = vi.fn(async () => "x");
    const controller = new AbortController();
    controller.abort();
    const outcomes = await runScheduled({
      tasks: [{ id: "a", run }, { id: "b", run }],
      concurrency: 2,
      signal: controller.signal,
    });
    expect(outcomes.map((o) => o.status)).toEqual(["cancelled", "cancelled"]);
    expect(run).not.toHaveBeenCalled();
  });

  it("abortar no meio cancela o que não começou e propaga o sinal para o que está rodando", async () => {
    const controller = new AbortController();
    let sinalRecebido: AbortSignal | undefined;
    const tasks: SchedulerTask<string>[] = [
      {
        id: "longa",
        run: async (ctx) => {
          sinalRecebido = ctx.signal;
          controller.abort();
          await sleep(5);
          throw new Error("interrompida");
        },
      },
      ok("nunca-roda"),
    ];
    const outcomes = await runScheduled({ tasks, concurrency: 1, signal: controller.signal });
    expect(sinalRecebido?.aborted).toBe(true);
    expect(outcomes[0]?.status).toBe("cancelled"); // lançou com o sinal abortado
    expect(outcomes[1]?.status).toBe("cancelled"); // nunca chegou a começar
  });
});
