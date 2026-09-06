import { appendFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 400;

/**
 * Persistência do estado de uma equipe fora do caminho quente do event loop.
 *
 * Antes, `emit()` reserializava o estado INTEIRO (incluindo o output completo
 * de todas as subtarefas) de forma síncrona a cada evento — inclusive a cada
 * mensagem de mailbox entregue. Com N agentes conversando isso bloqueava,
 * várias vezes por segundo, exatamente o loop que deveria estar despachando o
 * stdout dos outros agentes.
 *
 * Agora há dois canais com custos diferentes:
 *
 * - `appendEvent` grava uma linha em `events.jsonl` (append-only, assíncrono,
 *   sem reserializar nada). É o canal de alta frequência.
 * - `save` agenda um snapshot de `state.json` com debounce e escrita atômica
 *   assíncrona. É o canal de baixa frequência.
 *
 * Consequência aceita: `state.json` pode ficar até `debounceMs` atrás do
 * estado em memória. `team status` de outro terminal enxerga essa diferença.
 * Em troca, o laço de execução para de travar. Quem precisa de leitura
 * garantida chama `flush()` — o `finally` de `runTeam` sempre chama.
 */
export class TeamStore {
  private readonly statePath: string;
  private readonly eventsPath: string;
  private readonly debounceMs: number;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: unknown;
  /** Serializa as escritas: duas gravações concorrentes do mesmo arquivo poderiam intercalar. */
  private chain: Promise<void> = Promise.resolve();
  private queuedEvents: string[] = [];
  private failure: unknown;

  constructor(directory: string, options: { debounceMs?: number } = {}) {
    this.statePath = join(directory, "state.json");
    this.eventsPath = join(directory, "events.jsonl");
    this.debounceMs = options.debounceMs ?? DEFAULT_SNAPSHOT_DEBOUNCE_MS;
  }

  /**
   * Enfileira uma linha de evento. Não espera o disco: o custo por chamada é
   * um push num array, e o append acontece em lote no próximo turno.
   */
  appendEvent(event: string): void {
    this.queuedEvents.push(JSON.stringify({ at: new Date().toISOString(), event }));
    this.schedule();
  }

  /** Agenda um snapshot. Chamadas seguidas dentro da janela viram uma escrita só. */
  save(state: unknown): void {
    this.pending = state;
    this.schedule();
  }

  /**
   * Snapshot durável imediato, para transições que outro processo precisa
   * enxergar na hora — `team send` de outro terminal lê `status` do disco e
   * recusa a mensagem se ainda estiver "planning". São poucas por execução
   * (planning → running → integrating → terminal), então o custo é irrelevante
   * e o debounce continua valendo para o tráfego de alta frequência.
   */
  async saveNow(state: unknown): Promise<void> {
    this.save(state);
    await this.flush();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.enqueueWrite();
    }, this.debounceMs);
    // Um timer pendente não deve segurar o processo vivo sozinho — o `flush`
    // do `finally` é quem garante que nada se perde ao terminar.
    this.timer.unref?.();
  }

  private enqueueWrite(): void {
    const events = this.queuedEvents;
    const state = this.pending;
    this.queuedEvents = [];
    this.pending = undefined;
    if (!events.length && state === undefined) return;

    this.chain = this.chain
      .then(async () => {
        if (events.length) await appendFile(this.eventsPath, `${events.join("\n")}\n`, { mode: 0o600 });
        if (state !== undefined) await writeJsonAtomic(this.statePath, state);
      })
      .catch((error: unknown) => {
        // Guardado em vez de virar unhandled rejection: `flush()` propaga.
        this.failure ??= error;
      });
  }

  /** Grava tudo o que estiver pendente e espera o disco. Idempotente. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.enqueueWrite();
    await this.chain;
    if (this.failure) {
      const error = this.failure;
      this.failure = undefined;
      throw error;
    }
  }
}

/** Escrita atômica: grava num temporário e renomeia, pra nunca deixar um JSON truncado no lugar. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}
