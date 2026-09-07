import { describe, expect, it } from "vitest";
import { parsePlannerOutput, parseTeamPlan, pathsOverlap } from "./plan.js";
const a = { id: "api", agent: "codex", task: "implementar API", dependsOn: [] };
const b = { id: "tests", agent: "claude", task: "testar", dependsOn: ["api"] };
describe("plano de equipe", () => {
  it("aceita DAG fora de ordem e normaliza dependências ausentes", () => {
    expect(parseTeamPlan({ tasks: [b, a] }).tasks).toHaveLength(2);
    expect(parseTeamPlan({ tasks: [{ ...a, dependsOn: undefined }] }).tasks[0]?.dependsOn).toEqual([]);
  });
  it.each([
    {}, { tasks: [] }, { tasks: [a, a] },
    { tasks: [{ ...a, dependsOn: ["missing"] }] },
    { tasks: [{ ...a, dependsOn: ["api"] }] },
    { tasks: [{ ...a, dependsOn: ["tests"] }, b] },
    { tasks: [{ ...a, id: "../escape" }] },
    { tasks: [{ ...a, id: "planner" }] },
    { tasks: [{ ...a, id: "integration" }] },
    { tasks: [{ ...a, agent: "missing" }] },
    { tasks: [{ ...a, task: " " }] },
    { tasks: [{ ...b, dependsOn: ["api", "api"] }, a] },
  ])("rejeita plano inválido %j", (value) => { expect(() => parseTeamPlan(value)).toThrow(); });
  it("restringe plano aos agentes selecionados", () => {
    expect(() => parseTeamPlan({ tasks: [a] }, ["claude"])).toThrow("indisponível");
  });
  it("aceita JSON em bloco e recusa prosa inesperada", () => {
    expect(parsePlannerOutput('```json\n' + JSON.stringify({ tasks: [a] }) + '\n```', ["codex"]).tasks).toHaveLength(1);
    expect(() => parsePlannerOutput("Não consegui planejar", ["codex"])).toThrow("JSON válido");
  });
});

describe("pathsOverlap", () => {
  it("reconhece o mesmo caminho e contenção em fronteira de diretório", () => {
    expect(pathsOverlap("src/api/**", "src/api/**")).toBe(true);
    expect(pathsOverlap("src/**", "src/api/routes.ts")).toBe(true);
    expect(pathsOverlap("src/api/**", "src/api/routes.ts")).toBe(true);
    expect(pathsOverlap("./src/api/**", "src/api/x.ts")).toBe(true);
  });

  it("não confunde diretórios irmãos com prefixo parecido", () => {
    expect(pathsOverlap("src/api/**", "src/apiary/**")).toBe(false);
    expect(pathsOverlap("src/api/**", "src/web/**")).toBe(false);
    expect(pathsOverlap("README.md", "CHANGELOG.md")).toBe(false);
  });

  // Conservador de propósito: o falso positivo só obriga o plano a ser mais
  // específico; o falso negativo deixaria dois agentes se sobrescreverem.
  it("trata curingas no mesmo diretório como sobreposição, mesmo sem interseção real", () => {
    expect(pathsOverlap("src/*.ts", "src/*.js")).toBe(true);
  });
});

describe("posse de arquivos entre tarefas paralelas", () => {
  const owns = (id: string, paths: string[], dependsOn: string[] = []) =>
    ({ id, agent: "codex", task: "x", dependsOn, owns: paths });

  it("rejeita duas tarefas independentes que disputam os mesmos caminhos", () => {
    expect(() => parseTeamPlan({ tasks: [owns("api", ["src/db/**"]), owns("web", ["src/db/schema.ts"])] }))
      .toThrow("disputa de arquivos");
  });

  it("aceita quando os caminhos são disjuntos", () => {
    expect(parseTeamPlan({ tasks: [owns("api", ["src/api/**"]), owns("web", ["src/web/**"])] }).tasks).toHaveLength(2);
  });

  // Tarefas sequenciadas recebem o commit da outra antes de começar, então
  // compartilhar caminho ali é legítimo — não há escrita concorrente.
  it("aceita caminhos compartilhados quando há dependência direta", () => {
    expect(parseTeamPlan({ tasks: [owns("api", ["src/db/**"]), owns("web", ["src/db/**"], ["api"])] }).tasks).toHaveLength(2);
  });

  it("aceita caminhos compartilhados quando a dependência é transitiva", () => {
    const tasks = [owns("a", ["src/db/**"]), owns("b", [], ["a"]), owns("c", ["src/db/**"], ["b"])];
    expect(parseTeamPlan({ tasks }).tasks).toHaveLength(3);
  });

  it("plano sem owns continua válido, sem checagem (compatibilidade)", () => {
    expect(parseTeamPlan({ tasks: [a, b] }).tasks).toHaveLength(2);
  });

  it("rejeita owns com caminho absoluto ou saindo do projeto", () => {
    expect(() => parseTeamPlan({ tasks: [owns("api", ["/etc/passwd"])] })).toThrow("relativos");
    expect(() => parseTeamPlan({ tasks: [owns("api", ["../fora/**"])] })).toThrow("relativos");
  });
});
