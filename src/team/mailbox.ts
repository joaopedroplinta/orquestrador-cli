import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TeamMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  timestamp: string;
}
export const MAILBOX_DIRECTORY = ".orquestrador-team";

export function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

// Programa independente: funciona dentro de cada worktree sem npm install.
const helper = `const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = __dirname;
const [command, to, ...words] = process.argv.slice(2);
try {
  if (command === 'send') {
    const text = words.join(' ').trim();
    const members = JSON.parse(fs.readFileSync(path.join(root, 'members.json'), 'utf8'));
    if (!members.includes(to) && to !== 'all' && to !== 'user') throw new Error('Destinatário desconhecido');
    if (!text || text.length > 16000) throw new Error('Mensagem deve conter 1–16000 caracteres');
    const id = crypto.randomUUID();
    const file = path.join(root, 'outbox', id + '.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify({ id, to, text }), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    console.log('Mensagem enfileirada: ' + id);
  } else if (command === 'inbox') {
    const messages = fs.readdirSync(path.join(root, 'inbox')).filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(root, 'inbox', f), 'utf8')))
      .sort((a,b) => a.timestamp.localeCompare(b.timestamp));
    console.log(JSON.stringify(messages, null, 2));
  } else throw new Error('Uso: node .orquestrador-team/mailbox.cjs inbox | send <id|all|user> "mensagem"');
} catch (error) { console.error(error.message); process.exitCode = 1; }
`;

export function createMailbox(worktree: string, members: string[]): string {
  const root = join(worktree, MAILBOX_DIRECTORY);
  if (existsSync(root)) throw new Error(`Diretório reservado já existe: ${root}`);
  mkdirSync(join(root, "inbox"), { recursive: true });
  mkdirSync(join(root, "outbox"));
  writeJson(join(root, "members.json"), members);
  writeFileSync(join(root, "mailbox.cjs"), helper);
  return root;
}

export class TeamMailbox {
  readonly messages: TeamMessage[] = [];
  private seen = new Set<string>();
  constructor(private endpoints: Map<string, string>, private onMessage?: (message: TeamMessage) => void) {}

  /** Chamado continuamente enquanto os CLIs trabalham e também após cada conclusão. */
  flush(): void {
    for (const [from, root] of this.endpoints) {
      const outbox = join(root, "outbox");
      if (!lstatSync(outbox).isDirectory()) throw new Error(`Outbox inválida: ${from}`);
      for (const file of readdirSync(outbox).sort()) {
        if (!/^[a-f0-9-]{36}\.json$/.test(file) || this.seen.has(`${from}/${file}`)) continue;
        const path = join(outbox, file);
        if (!lstatSync(path).isFile() || lstatSync(path).size > 70_000) continue;
        let input;
        try { input = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
        if (!input || input.id !== file.slice(0, -5) || typeof input.text !== "string" || !input.text.trim() || input.text.length > 16_000) continue;
        if (input.to !== "all" && !this.endpoints.has(input.to)) continue;
        const message: TeamMessage = { id: `${from}-${input.id}`, from, to: input.to, text: input.text, timestamp: new Date().toISOString() };
        const recipients = input.to === "all" ? [...this.endpoints.keys()].filter((id) => id !== from) : [input.to];
        for (const recipient of recipients) {
          const inbox = join(this.endpoints.get(recipient)!, "inbox");
          if (!lstatSync(inbox).isDirectory()) throw new Error(`Inbox inválida: ${recipient}`);
          writeJson(join(inbox, `${message.id}.json`), message);
        }
        this.seen.add(`${from}/${file}`);
        this.messages.push(message);
        this.onMessage?.(message);
      }
    }
  }
}

export function queueUserMessage(root: string, to: string, text: string): void {
  if (!text.trim() || text.length > 16_000) throw new Error("Mensagem deve conter 1–16000 caracteres.");
  const id = randomUUID();
  writeJson(join(root, "outbox", `${id}.json`), { id, to, text });
}
