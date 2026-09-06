import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAILBOX_DIRECTORY, writeJson } from "./mailbox.js";

/**
 * Quadro de contratos compartilhado entre as subtarefas de uma equipe.
 *
 * O canal de mensagens é best-effort: entrega não é leitura, e um contrato de
 * API que só existe como texto solto numa mensagem pode nunca ser lido. Aqui
 * o acordo é um dado com dono e versão — dois agentes não conseguem definir a
 * mesma chave de formas divergentes, porque a segunda escrita é recusada e o
 * agente é obrigado a reler e reconciliar.
 *
 * Ao contrário das caixas de mensagem (uma por worktree), o arquivo é ÚNICO e
 * fica no diretório da equipe: N processos de agente escrevem nele ao mesmo
 * tempo. Por isso a exclusão mútua é um lockfile `O_EXCL` de verdade, não uma
 * seção crítica em memória — os escritores são processos separados.
 */

export const CONTRACTS_FILE = "contracts.json";

export interface ContractEntry {
  value: string;
  /** Subtarefa que definiu a chave — é o que dá a ela o direito de reescrevê-la. */
  owner: string;
  at: string;
}

export interface ContractBoard {
  version: number;
  entries: Record<string, ContractEntry>;
}

export function contractsPath(teamDirectory: string): string {
  return join(teamDirectory, CONTRACTS_FILE);
}

export function createContractBoard(teamDirectory: string): string {
  const path = contractsPath(teamDirectory);
  if (!existsSync(path)) writeJson(path, { version: 0, entries: {} } satisfies ContractBoard);
  return path;
}

export function readContractBoard(teamDirectory: string): ContractBoard {
  const path = contractsPath(teamDirectory);
  if (!existsSync(path)) return { version: 0, entries: {} };
  return JSON.parse(readFileSync(path, "utf8")) as ContractBoard;
}

/**
 * Decide se uma escrita é permitida, sem tocar em disco — a regra de negócio
 * isolada da concorrência, pra poder ser testada diretamente.
 *
 * Uma chave nova é livre. Reescrever a própria chave é livre (o dono mudou de
 * ideia). Reescrever a chave de OUTRA subtarefa é recusado: é exatamente a
 * divergência silenciosa que o quadro existe pra impedir. Reafirmar o mesmo
 * valor é permitido — é idempotente, não é conflito.
 */
export function canWriteContract(
  board: ContractBoard,
  key: string,
  value: string,
  writer: string,
): { ok: true } | { ok: false; reason: string } {
  const current = board.entries[key];
  if (!current) return { ok: true };
  if (current.owner === writer) return { ok: true };
  if (current.value === value) return { ok: true };
  return {
    ok: false,
    reason:
      `"${key}" já foi definida por ${current.owner} como ${JSON.stringify(current.value)}. ` +
      "Leia o valor atual e adeque-se a ele, ou combine a mudança por mensagem antes de reescrever.",
  };
}

// Programa independente, no mesmo molde do mailbox.cjs: roda com `node` puro
// dentro da worktree, sem instalar nada. O caminho do quadro é embutido na
// geração porque a worktree não sabe onde fica o diretório da equipe.
function helperSource(boardPath: string, taskId: string): string {
  return `const fs = require('node:fs');
const board = ${JSON.stringify(boardPath)};
const me = ${JSON.stringify(taskId)};
const lock = board + '.lock';
const [command, key, ...words] = process.argv.slice(2);

function read() {
  try { return JSON.parse(fs.readFileSync(board, 'utf8')); } catch { return { version: 0, entries: {} }; }
}

// Exclusão mútua entre PROCESSOS: O_EXCL falha se o arquivo já existe, então
// só um agente por vez entra na seção crítica. Espera ativa curta com limite —
// um agente nunca deve travar indefinidamente esperando outro.
function withLock(fn) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try { return fn(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() > deadline) throw new Error('Quadro de contratos ocupado; tente de novo.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

try {
  if (command === 'list') {
    console.log(JSON.stringify(read().entries, null, 2));
  } else if (command === 'get') {
    if (!key) throw new Error('Uso: contracts.cjs get <chave>');
    const entry = read().entries[key];
    console.log(entry ? JSON.stringify(entry, null, 2) : '(não definida)');
  } else if (command === 'set') {
    const value = words.join(' ').trim();
    if (!key || !value) throw new Error('Uso: contracts.cjs set <chave> <valor>');
    if (key.length > 200 || value.length > 8000) throw new Error('Chave até 200 e valor até 8000 caracteres.');
    withLock(() => {
      const current = read();
      const existing = current.entries[key];
      if (existing && existing.owner !== me && existing.value !== value) {
        throw new Error('"' + key + '" já foi definida por ' + existing.owner + ' como ' + JSON.stringify(existing.value) +
          '. Leia o valor atual e adeque-se a ele, ou combine a mudança por mensagem antes de reescrever.');
      }
      current.entries[key] = { value: value, owner: me, at: new Date().toISOString() };
      current.version = (current.version || 0) + 1;
      const tmp = board + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(current, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, board);
      console.log('Contrato registrado: ' + key);
    });
  } else {
    throw new Error('Uso: node .orquestrador-team/contracts.cjs list | get <chave> | set <chave> <valor>');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
`;
}

/**
 * Instala o utilitário dentro da caixa já criada da worktree. O id da
 * subtarefa é embutido na geração em vez de vir de variável de ambiente: cada
 * worktree tem seu próprio helper, então o dono da escrita é estrutural — um
 * agente não consegue se passar por outro editando o ambiente.
 */
export function installContractHelper(worktree: string, teamDirectory: string, taskId: string): void {
  const root = join(worktree, MAILBOX_DIRECTORY);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "contracts.cjs"), helperSource(contractsPath(teamDirectory), taskId));
}
