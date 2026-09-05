import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../orchestrator/pipeline.js", () => ({ runPipeline: vi.fn() }));
vi.mock("../storage/history.js", () => ({ listRuns: vi.fn() }));

import { cleanup, render } from "ink-testing-library";
import type { RunPipelineOptions } from "../orchestrator/pipeline.js";
import { runPipeline } from "../orchestrator/pipeline.js";
import { listRuns } from "../storage/history.js";
import { PipelineCancelledError, type AgentName, type AgentRunResult, type HistoryRun } from "../types.js";
import App from "./App.js";

const mockedRunPipeline = vi.mocked(runPipeline);
const mockedListRuns = vi.mocked(listRuns);

interface FakeStdin {
  write: (data: string) => void;
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Ink trata vários caracteres escritos no mesmo tick como "colar texto" (perde
// a semântica de tecla individual, ver CLAUDE.md) — por isso cada caractere
// aqui aguarda um tick antes do próximo, replicando o timing real de alguém
// digitando (a mesma lição aprendida testando a TUI com PTY real).
async function typeText(stdin: FakeStdin, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await tick();
  }
}

async function submit(stdin: FakeStdin, text: string): Promise<void> {
  await typeText(stdin, text);
  stdin.write("\r");
  await tick();
}

function fakeStep(agent: AgentName, output: string): AgentRunResult {
  return {
    agent,
    prompt: "prompt",
    output,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 10,
  };
}

function fakeHistoryRun(overrides: Partial<HistoryRun> = {}): HistoryRun {
  return {
    id: "abcdef1234567890",
    task: "pesquisar X",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    steps: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("App (TUI)", () => {
  it("renderiza o banner de boas-vindas uma única vez", () => {
    const { lastFrame } = render(<App />);
    const frame = lastFrame() ?? "";

    expect(frame).toContain("orquestrador");
    expect(frame.split("⚡ orquestrador")).toHaveLength(2); // exatamente 1 ocorrência
  });

  it("roda uma tarefa completa: spinner aparece, depois o resultado, e o input volta a ficar ativo", async () => {
    let resolvePipeline!: (value: Awaited<ReturnType<typeof runPipeline>>) => void;
    mockedRunPipeline.mockReturnValue(
      new Promise((resolve) => {
        resolvePipeline = resolve;
      }),
    );

    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "pesquisar node");

    expect(lastFrame()).toContain("Rodando: pesquisar node");
    expect(lastFrame()).toContain("→ antigravity");

    resolvePipeline({ runId: "run-1", task: "pesquisar node", steps: [fakeStep("antigravity", "resposta de teste")] });
    await tick();
    await tick();

    expect(lastFrame()).not.toContain("Rodando");
    expect(lastFrame()).toContain("[antigravity]");
    expect(lastFrame()).toContain("resposta de teste");
    expect(lastFrame()).toContain("digite uma tarefa..."); // placeholder = input ativo de novo

    await typeText(stdin, "ok");
    expect(lastFrame()).toContain("❯ ok");
  });

  it("tarefa ambígua abre o prompt de escolha de agente embutido na tela", async () => {
    mockedRunPipeline.mockImplementation(
      (options: RunPipelineOptions) =>
        new Promise((resolve, reject) => {
          void options.resolveAmbiguousAgent?.("boa tarde").then((chosen) => {
            if (!chosen) {
              reject(new PipelineCancelledError("boa tarde"));
              return;
            }
            resolve({ runId: "run-1", task: "boa tarde", steps: [fakeStep(chosen, "ok")] });
          });
        }),
    );

    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "boa tarde");

    expect(lastFrame()).toContain("Não consegui identificar automaticamente qual agente usar pra");
    expect(lastFrame()).toContain("claude | antigravity | cancelar");

    await submit(stdin, "claude");
    await tick();

    expect(lastFrame()).toContain("[claude]");
  });

  it("cancelar a escolha de agente mostra a mensagem de cancelamento, não um erro", async () => {
    mockedRunPipeline.mockImplementation(
      (options: RunPipelineOptions) =>
        new Promise((_resolve, reject) => {
          void options.resolveAmbiguousAgent?.("boa tarde").then((chosen) => {
            reject(chosen ? new Error("não deveria escolher agente aqui") : new PipelineCancelledError("boa tarde"));
          });
        }),
    );

    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "boa tarde");
    await submit(stdin, "cancelar");
    await tick();

    expect(lastFrame()).toContain("Execução cancelada");
  });
});

describe("App (TUI) — slash commands", () => {
  it("/agent muda o agente forçado e reflete na StatusLine e no transcript", async () => {
    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "/agent claude");

    expect(lastFrame()).toContain("Agente forçado: claude");
    expect(lastFrame()).toContain("agente: claude (forçado)");
  });

  it("/auto liga a classificação automática sem afetar o agente forçado", async () => {
    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "/agent claude");
    await submit(stdin, "/auto");

    expect(lastFrame()).toContain("Classificação automática (--auto) ligada.");
    expect(lastFrame()).toContain("agente: claude (forçado)");
    expect(lastFrame()).toContain("auto: ligado");
  });

  it("/agent auto reseta o roteamento normal mantendo o --auto ligado", async () => {
    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "/agent claude");
    await submit(stdin, "/auto");
    await submit(stdin, "/agent auto");

    expect(lastFrame()).toContain("Roteamento normal restaurado");
    expect(lastFrame()).toContain("agente: automático");
    expect(lastFrame()).toContain("auto: ligado");
  });

  it("/history lista as execuções passadas", async () => {
    mockedListRuns.mockReturnValue([fakeHistoryRun()]);

    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "/history");

    expect(lastFrame()).toContain("pesquisar X");
  });

  it("/history sem execuções mostra a mensagem de lista vazia", async () => {
    mockedListRuns.mockReturnValue([]);

    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "/history");

    expect(lastFrame()).toContain("Nenhuma execução registrada ainda.");
  });

  it("comando desconhecido mostra erro amigável, sem quebrar a tela", async () => {
    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "/foobar");

    expect(lastFrame()).toContain('Comando desconhecido: "/foobar"');

    // a tela continua funcional depois do erro
    await submit(stdin, "/agent claude");
    expect(lastFrame()).toContain("agente: claude (forçado)");
  });

  it("/exit encerra a aplicação", async () => {
    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "/exit");
    await tick();

    expect(lastFrame()?.trim()).toBe("");
  });
});

// Estes testes NÃO usam typeText()/submit() (que aguardam um tick por
// caractere) de propósito: escrevem tudo em sequência, sem dar tempo pro
// React re-renderizar entre uma tecla e outra. É o cenário que derrubava
// caractere com o ink-text-input (o cálculo do próximo valor partia da prop
// `value` do último render, que ainda não tinha atualizado — ver
// PromptInput.tsx). Se algum dia esse componente for trocado por outro que
// reintroduza esse padrão, estes testes devem voltar a falhar.
describe("App (TUI) — digitação em rajada, sem tick() de proteção entre teclas", () => {
  it("não perde nenhum caractere", async () => {
    const { lastFrame, stdin } = render(<App />);

    for (const ch of "pesquisar node") {
      stdin.write(ch);
    }
    await tick();

    expect(lastFrame()).toContain("pesquisar node");
  });

  it("Enter chegando logo em seguida ainda submete o texto completo (nenhum caractere comido)", async () => {
    mockedRunPipeline.mockResolvedValue({
      runId: "run-1",
      task: "implementar algo",
      steps: [fakeStep("claude", "feito")],
    });

    const { stdin } = render(<App />);

    for (const ch of "implementar algo") {
      stdin.write(ch);
    }
    stdin.write("\r");
    await tick();
    await tick();

    expect(mockedRunPipeline).toHaveBeenCalledWith(expect.objectContaining({ task: "implementar algo" }));
  });

  it("um slash command digitado em rajada ainda é reconhecido corretamente", async () => {
    const { lastFrame, stdin } = render(<App />);

    for (const ch of "/agent claude") {
      stdin.write(ch);
    }
    stdin.write("\r");
    await tick();

    expect(lastFrame()).toContain("agente: claude (forçado)");
  });
});
