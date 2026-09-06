import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../orchestrator/pipeline.js", () => ({ runPipeline: vi.fn(), runPipelines: vi.fn() }));
vi.mock("../storage/history.js", () => ({ listRuns: vi.fn() }));
vi.mock("../systemStatus.js", () => ({
  getGitBranch: vi.fn().mockResolvedValue("main"),
  getSystemStatus: vi.fn().mockResolvedValue({
    cwd: "/test",
    projectName: "test-project",
    gitBranch: "main",
    nodeVersion: "v20.0.0",
    historyRunsCount: 5,
    claude: { installed: true, version: "1.0.0" },
    antigravity: { installed: true, version: "2.0.0" },
  }),
}));

import { cleanup, render } from "ink-testing-library";
import type { RunManyOptions, RunPipelineOptions } from "../orchestrator/pipeline.js";
import { runPipeline, runPipelines } from "../orchestrator/pipeline.js";
import { listRuns } from "../storage/history.js";
import { PipelineCancelledError, type AgentName, type AgentRunResult, type HistoryRun } from "../types.js";
import App from "./App.js";

const mockedRunPipeline = vi.mocked(runPipeline);
const mockedRunPipelines = vi.mocked(runPipelines);
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
    let resolvePipeline!: () => void;
    let capturedOptions!: RunPipelineOptions;
    mockedRunPipeline.mockImplementation((options) => {
      capturedOptions = options;
      return new Promise((resolve) => {
        resolvePipeline = () => resolve({ runId: "run-1", task: options.task, steps: [] });
      });
    });

    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "pesquisar node");

    expect(lastFrame()).toContain("Rodando: pesquisar node");
    expect(lastFrame()).toContain("→ antigravity");

    // Simula o que o runPipeline de verdade faz: onStepComplete assim que a
    // etapa termina, e só depois a promise inteira resolve.
    capturedOptions.onStepComplete?.(fakeStep("antigravity", "resposta de teste"));
    resolvePipeline();
    await tick();
    await tick();

    expect(lastFrame()).not.toContain("Rodando");
    expect(lastFrame()).toContain("[antigravity]");
    expect(lastFrame()).toContain("resposta de teste");
    expect(lastFrame()).toContain("digite uma tarefa..."); // placeholder = input ativo de novo

    await typeText(stdin, "ok");
    expect(lastFrame()).toContain("❯ ok");
  });

  it('prefixo "agente:" na tarefa força a prévia de rota, mesmo com keyword indicando outro agente', async () => {
    mockedRunPipeline.mockImplementation(
      (options) => new Promise((resolve) => resolve({ runId: "run-1", task: options.task, steps: [] })),
    );

    const { lastFrame, stdin } = render(<App />);
    // "implementar" normalmente roteia pro claude — o prefixo força antigravity mesmo assim.
    await submit(stdin, "antigravity: implementar algo");
    await tick();

    expect(lastFrame()).toContain("→ antigravity");
    expect(mockedRunPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ task: "antigravity: implementar algo" }),
    );
  });

  it("mostra o output chegando ao vivo enquanto a etapa roda (antes de terminar)", async () => {
    let capturedOptions!: RunPipelineOptions;
    mockedRunPipeline.mockImplementation((options) => {
      capturedOptions = options;
      return new Promise(() => {}); // nunca resolve nesse teste -- só nos interessa o "durante"
    });

    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "pesquisar node");

    capturedOptions.onStepStart?.("antigravity");
    capturedOptions.onChunk?.("antigravity", "primeiro pedaço ");
    await tick();
    capturedOptions.onChunk?.("antigravity", "segundo pedaço");
    await tick();

    expect(lastFrame()).toContain("[antigravity]");
    expect(lastFrame()).toContain("primeiro pedaço segundo pedaço");
    expect(lastFrame()).not.toContain("(simulando…)"); // antigravity streama de verdade
  });

  it('marca "(simulando…)" quando o agente não streama de verdade (claude)', async () => {
    let capturedOptions!: RunPipelineOptions;
    mockedRunPipeline.mockImplementation((options) => {
      capturedOptions = options;
      return new Promise(() => {});
    });

    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "implementar algo");

    capturedOptions.onStepStart?.("claude");
    capturedOptions.onChunk?.("claude", "texto revelado aos poucos");
    await tick();

    expect(lastFrame()).toContain("[claude]");
    expect(lastFrame()).toContain("(simulando…)");
    expect(lastFrame()).toContain("texto revelado aos poucos");
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
            const stepResult = fakeStep(chosen, "ok");
            options.onStepComplete?.(stepResult);
            resolve({ runId: "run-1", task: "boa tarde", steps: [stepResult] });
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

  it("/routing classify muda a estratégia e reflete na StatusLine, sem afetar agente/auto", async () => {
    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "/agent claude");
    await submit(stdin, "/routing classify");

    expect(lastFrame()).toContain("Roteamento: classify");
    expect(lastFrame()).toContain("roteamento: classify");
    expect(lastFrame()).toContain("agente: claude (forçado)"); // não mexeu no que já estava setado
  });

  it("/routing com argumento inválido mostra erro amigável, sem mudar o estado", async () => {
    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "/routing banana");

    expect(lastFrame()).toContain('Uso: "/routing keyword" ou "/routing classify"');
    expect(lastFrame()).toContain("roteamento: keyword"); // continua no padrão
  });

  it("uma tarefa rodada com /routing classify chega em runPipeline com routing: \"classify\"", async () => {
    let capturedOptions!: RunPipelineOptions;
    mockedRunPipeline.mockImplementation(
      (options) => new Promise((resolve) => {
        capturedOptions = options;
        resolve({ runId: "run-1", task: options.task, steps: [] });
      }),
    );

    const { stdin } = render(<App />);
    await submit(stdin, "/routing classify");
    await submit(stdin, "implementar algo");
    await tick();

    expect(capturedOptions.routing).toBe("classify");
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

  it("/help exibe guia de comandos e categorias", async () => {
    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "/help");

    expect(lastFrame()).toContain("Comandos do Orquestrador");
    expect(lastFrame()).toContain("/status");
    expect(lastFrame()).toContain("/history");
  });

  it("/status exibe diagnóstico do ambiente", async () => {
    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "/status");
    await tick();
    await tick();

    expect(lastFrame()).toContain("Diagnóstico do Ambiente");
    expect(lastFrame()).toContain("Node.js");
  });

  it("/clear limpa o histórico de exibição mantendo o banner", async () => {
    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "/help");
    expect(lastFrame()).toContain("Comandos do Orquestrador");

    await submit(stdin, "/clear");
    await tick();
    await tick();
    expect(lastFrame()).toContain("Histórico visual limpo.");
    expect(lastFrame()).toContain("⚡ orquestrador");
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

describe("App (TUI) — múltiplas tarefas em paralelo (';')", () => {
  it("duas tarefas separadas por ';' rodam em paralelo e cada resultado aparece no bloco certo", async () => {
    let capturedOptions!: RunManyOptions;
    mockedRunPipelines.mockImplementation(async (options) => {
      capturedOptions = options;
      options.onTaskStepComplete?.(0, fakeStep("antigravity", "resultado da pesquisa"));
      options.onTaskStepComplete?.(1, fakeStep("claude", "resultado da implementação"));
      return options.tasks.map((task) => ({ task, result: { runId: "r", task, steps: [] } }));
    });

    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "pesquisar X; implementar Y");
    await tick();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Tarefa 1/2");
    expect(frame).toContain("pesquisar X");
    expect(frame).toContain("resultado da pesquisa");
    expect(frame).toContain("Tarefa 2/2");
    expect(frame).toContain("implementar Y");
    expect(frame).toContain("resultado da implementação");
    expect(capturedOptions.tasks).toEqual(["pesquisar X", "implementar Y"]);
  });

  it("streaming de duas tarefas concorrentes aparece em blocos separados, sem se misturar", async () => {
    mockedRunPipelines.mockImplementation(async (options) => {
      options.onTaskStepStart?.(0, "antigravity");
      options.onTaskStepStart?.(1, "claude");
      options.onTaskChunk?.(0, "antigravity", "texto da tarefa um chegando");
      options.onTaskChunk?.(1, "claude", "texto da tarefa dois, bem diferente");
      return new Promise(() => {}); // nunca resolve nesse teste -- só interessa o "durante"
    });

    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "pesquisar X; implementar Y");
    await tick();

    const frame = lastFrame() ?? "";
    // "Tarefa 1/2" aparece 2x (anúncio estático da tarefa + label da caixa ao
    // vivo) — pega a ÚLTIMA ocorrência de cada uma, que é a seção "ao vivo".
    const liveTask1Start = frame.lastIndexOf("Tarefa 1/2");
    const liveTask2Start = frame.indexOf("Tarefa 2/2", liveTask1Start);
    const task1Section = frame.slice(liveTask1Start, liveTask2Start);
    const task2Section = frame.slice(liveTask2Start);

    expect(task1Section).toContain("[antigravity]");
    expect(task1Section).toContain("texto da tarefa um chegando");
    expect(task1Section).not.toContain("texto da tarefa dois");

    expect(task2Section).toContain("[claude]");
    expect(task2Section).toContain("(simulando…)");
    expect(task2Section).toContain("texto da tarefa dois, bem diferente");
    expect(task2Section).not.toContain("texto da tarefa um");
  });

  it("tarefa ambígua dentro do lote vira erro reportado, não abre o prompt de escolha", async () => {
    mockedRunPipelines.mockImplementation(async (options) => {
      options.onTaskStepComplete?.(0, fakeStep("antigravity", "ok"));
      return [
        { task: options.tasks[0]!, result: { runId: "r", task: options.tasks[0]!, steps: [] } },
        { task: options.tasks[1]!, error: new Error('Não foi possível decidir qual agente usar pra: "boa tarde"') },
      ];
    });

    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "pesquisar X; boa tarde");
    await tick();

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Não consegui identificar automaticamente"); // nunca abre o prompt embutido
    expect(frame).toContain("Não foi possível decidir");
    expect(frame).toContain("digite uma tarefa..."); // input voltou a ficar ativo, não travou esperando resposta
  });

  it('prefixo "agente:" por tarefa dentro do lote força cada uma pro agente certo, mesmo com keyword contrária', async () => {
    let capturedOptions!: RunManyOptions;
    mockedRunPipelines.mockImplementation(async (options) => {
      capturedOptions = options;
      return new Promise(() => {}); // só interessa a prévia de rota, não o resultado
    });

    const { lastFrame, stdin } = render(<App />);
    // as duas tarefas têm keyword "implementar" (routing normal levaria as
    // duas pro claude) — os prefixos forçam agentes opostos e diferentes entre si.
    await submit(stdin, "claude: implementar X; antigravity: implementar Y");
    await tick();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Tarefa 1/2");
    expect(frame).toContain("→ claude");
    expect(frame).toContain("Tarefa 2/2");
    expect(frame).toContain("→ antigravity");
    expect(capturedOptions.tasks).toEqual(["claude: implementar X", "antigravity: implementar Y"]);
  });
});

describe("App (TUI) — mascote", () => {
  it("o banner mostra o pinguim por padrão (mascote ligado)", () => {
    const { lastFrame } = render(<App />);
    // Uma das linhas da arte do banner — ver mascot.ts (MASCOT_BANNER_LINES).
    expect(lastFrame()).toContain("/o o\\");
  });

  it("--no-mascot (initialMascotEnabled=false) tira o pinguim do banner e da StatusLine", () => {
    const { lastFrame } = render(<App initialMascotEnabled={false} />);
    expect(lastFrame()).not.toContain("/o o\\");
    expect(lastFrame()).toContain("mascote: desligado");
  });

  it("/mascot alterna o estado e reflete na StatusLine", async () => {
    const { lastFrame, stdin } = render(<App />);
    expect(lastFrame()).toContain("mascote: ligado");

    await submit(stdin, "/mascot");
    expect(lastFrame()).toContain("Mascote desligado.");
    expect(lastFrame()).toContain("mascote: desligado");

    await submit(stdin, "/mascot");
    expect(lastFrame()).toContain("Mascote ligado.");
    expect(lastFrame()).toContain("mascote: ligado");
  });

  it("mostra o frame de \"pensando\" do mascote (em vez do spinner padrão) enquanto uma tarefa roda", async () => {
    mockedRunPipeline.mockImplementation(() => new Promise(() => {})); // nunca resolve — só interessa o "durante"

    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "pesquisar node");

    expect(lastFrame()).toContain("(o o)"); // primeiro frame de MASCOT_THINKING_FRAMES, tick inicial
  });

  it("tarefa bem-sucedida mostra a carinha feliz do mascote junto do resultado", async () => {
    mockedRunPipeline.mockImplementation(
      (options) =>
        new Promise((resolve) => {
          options.onStepComplete?.(fakeStep("antigravity", "ok"));
          resolve({ runId: "run-1", task: options.task, steps: [] });
        }),
    );

    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "pesquisar node");
    await tick();

    expect(lastFrame()).toContain("(^ ^)");
  });

  it("tarefa com erro mostra a carinha confusa do mascote junto da mensagem de erro", async () => {
    mockedRunPipeline.mockRejectedValue(new Error("algo deu errado"));

    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "pesquisar node");
    await tick();

    expect(lastFrame()).toContain("(? ?)");
    expect(lastFrame()).toContain("algo deu errado");
  });

  it("cancelamento mostra a carinha neutra do mascote junto da mensagem de cancelamento", async () => {
    mockedRunPipeline.mockImplementation(
      (options: RunPipelineOptions) =>
        new Promise((_resolve, reject) => {
          void options.resolveAmbiguousAgent?.("boa tarde").then(() => {
            reject(new PipelineCancelledError("boa tarde"));
          });
        }),
    );

    const { lastFrame, stdin } = render(<App />);
    await submit(stdin, "boa tarde");
    await submit(stdin, "cancelar");
    await tick();

    expect(lastFrame()).toContain("(- -)");
    expect(lastFrame()).toContain("Execução cancelada");
  });

  it("com o mascote desligado, nenhuma carinha aparece no resultado nem no erro", async () => {
    mockedRunPipeline.mockImplementation(
      (options) =>
        new Promise((resolve) => {
          options.onStepComplete?.(fakeStep("antigravity", "ok"));
          resolve({ runId: "run-1", task: options.task, steps: [] });
        }),
    );

    const { lastFrame, stdin } = render(<App initialMascotEnabled={false} />);
    await submit(stdin, "pesquisar node");
    await tick();

    expect(lastFrame()).not.toContain("(^ ^)");
    expect(lastFrame()).not.toContain("(o o)");
  });
});
