import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { createMailbox, TeamMailbox } from "./mailbox.js";
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
describe("caixa de mensagens", () => {
  it("entrega mensagens de processos reais, broadcast e deduplica polls", async () => {
    const root = mkdtempSync(join(tmpdir(), "orquestrador-mail-")); roots.push(root);
    const endpoints = new Map(["api", "tests", "user"].map((id) => [id, createMailbox(join(root, id), ["api", "tests"])]));
    const mailbox = new TeamMailbox(endpoints);
    await execa(process.execPath, [join(endpoints.get("api")!, "mailbox.cjs"), "send", "tests", "contrato pronto"]);
    mailbox.flush(); mailbox.flush();
    const { stdout } = await execa(process.execPath, [join(endpoints.get("tests")!, "mailbox.cjs"), "inbox"]);
    expect(JSON.parse(stdout)).toEqual([expect.objectContaining({ from: "api", to: "tests", text: "contrato pronto" })]);
    expect(mailbox.messages).toHaveLength(1);
    await execa(process.execPath, [join(endpoints.get("tests")!, "mailbox.cjs"), "send", "all", "testes prontos"]);
    mailbox.flush();
    expect(readdirSync(join(endpoints.get("user")!, "inbox"))).toHaveLength(1);
    expect(readdirSync(join(endpoints.get("api")!, "inbox"))).toHaveLength(1);
  });
  it("não confia no remetente declarado e ignora destinatário inválido", () => {
    const root = mkdtempSync(join(tmpdir(), "orquestrador-mail-")); roots.push(root);
    const a = createMailbox(join(root, "a"), ["a", "b"]);
    const b = createMailbox(join(root, "b"), ["a", "b"]);
    const mailbox = new TeamMailbox(new Map([["a", a], ["b", b]]));
    const id = "11111111-1111-1111-1111-111111111111";
    writeFileSync(join(a, "outbox", `${id}.json`), JSON.stringify({ id, from: "admin", to: "b", text: "oi" }));
    mailbox.flush();
    expect(mailbox.messages[0]?.from).toBe("a");
    const bad = "22222222-2222-2222-2222-222222222222";
    writeFileSync(join(a, "outbox", `${bad}.json`), JSON.stringify({ id: bad, to: "../escape", text: "oi" }));
    mailbox.flush();
    expect(mailbox.messages).toHaveLength(1);
  });
});
