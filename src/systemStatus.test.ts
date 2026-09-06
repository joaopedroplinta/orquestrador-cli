import { describe, expect, it } from "vitest";
import { checkCli, getGitBranch, getSystemStatus, isGitClean } from "./systemStatus.js";

describe("systemStatus", () => {
  it("checkCli identifica comandos existentes como node", async () => {
    const health = await checkCli("node");
    expect(health.installed).toBe(true);
    expect(health.version).toBeDefined();
  });

  it("checkCli identifica comandos inexistentes", async () => {
    const health = await checkCli("comando_inexistente_xyz_12345");
    expect(health.installed).toBe(false);
    expect(health.error).toBeDefined();
  });

  it("getGitBranch retorna branch ou null", async () => {
    const branch = await getGitBranch();
    expect(typeof branch === "string" || branch === null).toBe(true);
  });

  it("isGitClean retorna boolean ou null fora de um repositório", async () => {
    const clean = await isGitClean();
    expect(typeof clean === "boolean" || clean === null).toBe(true);
  });

  it("getSystemStatus retorna objeto completo com status", async () => {
    const status = await getSystemStatus();
    expect(status.projectName).toBeDefined();
    expect(status.nodeVersion).toBe(process.version);
    expect(typeof status.gitClean === "boolean" || status.gitClean === null).toBe(true);
    expect(typeof status.historyRunsCount).toBe("number");
    expect(typeof status.codex.installed).toBe("boolean");
    expect(typeof status.claude.installed).toBe("boolean");
    expect(typeof status.antigravity.installed).toBe("boolean");
  });
});
