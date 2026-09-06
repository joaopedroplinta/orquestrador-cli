import { describe, expect, it } from "vitest";
import type { TeamState } from "./coordinator.js";
import { formatTeamEvent, renderTeamDashboard } from "./presentation.js";

const state: TeamState = {
  id: "12345678-1234-1234-1234-123456789abc",
  task: "Implementar login com uma mensagem de objetivo suficientemente longa para testar o corte de texto do painel.",
  root: "/repo", base: "abcdef", directory: "/teams/123", status: "partial", startedAt: "2026-01-01T00:00:00.000Z",
  tasks: [
    { id: "api", agent: "codex", task: "Implementar API de autenticação", dependsOn: [], status: "completed", worktree: "/api", branch: "api", commit: "abc" },
    { id: "ui", agent: "claude", task: "Implementar formulário", dependsOn: ["api"], status: "blocked", worktree: "/ui", branch: "ui", error: "A dependência api não concluiu em um cenário simulado." },
  ],
  messages: [{ id: "m1", from: "api", to: "ui", text: "Contrato: POST /login retorna token", timestamp: "2026-01-01T00:00:01.000Z" }],
  integration: { worktree: "/integration", branch: "orquestrador/test/integration", merged: ["api"] },
};

describe("painel de equipe", () => {
  it("resume estado, tarefas, dependências, integração e erro", () => {
    const output = renderTeamDashboard(state);
    expect(output).toContain("equipe 12345678 ─ ◐ parcial");
    expect(output).toContain("✓ api");
    expect(output).toContain("⊘ ui");
    expect(output).toContain("depende de api");
    expect(output).toContain("orquestrador/test/integration");
    expect(output).not.toContain("POST /login");
  });

  it("mostra no máximo as cinco mensagens recentes quando solicitado", () => {
    const output = renderTeamDashboard({ ...state, messages: Array.from({ length: 7 }, (_, i) => ({ ...state.messages[0]!, id: `m${i}`, text: `mensagem ${i}` })) }, true);
    expect(output).toContain("mensagens recentes (7)");
    expect(output).not.toContain("mensagem 0");
    expect(output).toContain("mensagem 6");
  });
});

describe("eventos de equipe", () => {
  it.each([
    ["Equipe 12345678-1234-1234-1234-123456789abc: /teams/id", "✨ Equipe 12345678 criada"],
    ["[api/codex] iniciando", "▶ api · codex iniciou"],
    ["[api] concluída (a1b2c3d4)", "✓ api concluída · commit a1b2c3d4"],
    ["[ui] blocked", "⊘ ui blocked"],
    ["[mensagem api → ui] POST /login", "✉ api → ui: POST /login"],
    ["Integrando resultados em uma worktree separada...", "↻ Integrando resultados em uma worktree separada..."],
  ])("formata %s", (event, expected) => expect(formatTeamEvent(event)).toBe(expected));
});
