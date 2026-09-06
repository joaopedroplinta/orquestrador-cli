import { describe, expect, it } from "vitest";
import { parsePlannerOutput, parseTeamPlan } from "./plan.js";
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
