# orquestrador-cli

CLI em Node.js/TypeScript que orquestra duas ferramentas de IA agentic —
**Claude Code** (`claude`) e **Antigravity CLI** (`agy`) — numa mesma tarefa.
Em vez de você decidir na mão qual ferramenta usar pra pesquisar algo e qual
usar pra implementar, o orquestrador decide isso, dispara os comandos via
shell, repassa o resultado de uma etapa como contexto de entrada da próxima,
e guarda tudo num histórico consultável.

## Instalação

Requisitos:

- Node.js >= 20
- Os CLIs `claude` e `agy` instalados e **já autenticados** na máquina — o
  orquestrador nunca lida com login/credenciais, só assume que os dois
  comandos funcionam no PATH.

```bash
npm install
npm run build
npm link        # opcional: expõe o binário `orquestrador` globalmente
```

Sem `npm link`, rode via `node dist/cli.js <comando>` ou `npm run dev -- <comando>`.

## Uso

### `orquestrador run "<tarefa>"`

Roda o fluxo completo pra uma tarefa. Por padrão, o roteamento é decidido por
palavra-chave no texto da tarefa:

| Sinal na tarefa                                                              | Agente         |
| ----------------------------------------------------------------------------- | -------------- |
| "pesquisar", "buscar", "o que é", "última versão de"                          | Antigravity    |
| "implementar", "criar arquivo", "refatorar", "corrigir bug", "corrigir"        | Claude Code    |
| os dois tipos de sinal ao mesmo tempo                                         | Antigravity → Claude Code, em sequência, com handoff de contexto |
| nenhum sinal (ambíguo)                                                        | ver fallback abaixo |

Flags:

- **`--agent <claude|antigravity>`** — força um agente específico, ignora o
  roteamento por completo. Tem prioridade sobre tudo, inclusive `--auto`.
- **`--auto`** — quando o roteamento por palavra-chave não identifica nenhum
  agente, faz uma chamada leve e separada ao `claude` pedindo só a
  classificação da tarefa ("pesquisa" / "implementação" / "ambos") antes de
  cair no prompt interativo. Essa chamada de classificação não é uma etapa
  do pipeline e não entra no histórico.

**Fallback quando a tarefa é ambígua e nada mais resolveu:** o CLI pergunta
no terminal qual agente usar (`claude`, `antigravity` ou `cancelar`). Se a
entrada não for interativa (stdin não é um TTY — por exemplo, rodando em CI
ou com output redirecionado), cancela direto com uma mensagem indicando
`--agent`.

#### Exemplos

```bash
orquestrador run "pesquisar a última versão do Node.js"
# → roteia direto pro Antigravity

orquestrador run "implementar um endpoint de login"
# → roteia direto pro Claude Code

orquestrador run "pesquisar a versão mais recente do Express e implementar o upgrade"
# → Antigravity (pesquisa) primeiro, depois Claude Code (implementação),
#   recebendo o output da pesquisa como contexto

orquestrador run "revisar a stack do projeto" --agent claude
# → força o Claude Code, ignora o roteamento por palavra-chave

orquestrador run "e aí, isso aqui tá bom?" --auto
# → tarefa ambígua por palavra-chave; classifica via claude antes de
#   cair no prompt interativo

orquestrador run "e aí, isso aqui tá bom?"
# → tarefa ambígua, sem --auto: pergunta no terminal
#   Escolha o agente ["claude" | "antigravity" | "cancelar"]:
```

### `orquestrador history`

Lista as execuções passadas, mais recente primeiro:

```bash
orquestrador history
```

### `orquestrador history --last`

Mostra o detalhe da última execução — cada etapa, agente, prompt enviado
(já com o contexto da etapa anterior embutido, quando houver), output,
duração, e uma referência de qual etapa alimentou qual:

```bash
orquestrador history --last
```

## Arquitetura

```
  orquestrador run "<tarefa>"
       │
       ▼
┌────────────┐
│ router.ts  │  decide o plano por palavra-chave;
│ planTask() │  --auto / prompt interativo entram
└────────────┘  só se o resultado vier vazio
       │  plano = [ {agente, prompt}, ... ]
       ▼
┌───────────────┐
│ pipeline.ts   │
│ runPipeline() │  roda cada etapa do plano, em ordem
└───────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│ agents/antigravity.ts  (agy -p "...")    │
│ agents/claudeCode.ts   (claude -p "...") │
└──────────────────────────────────────────┘
       │  output da etapa vira "context" da
       │  próxima etapa do plano (handoff)
       ▼
┌─────────────────────────────────────┐
│ storage/history.ts                  │
│ SQLite (~/.orquestrador/history.db) │
│ runs + steps; fed_by_step_id liga   │
│ cada etapa à etapa que a alimentou  │
└─────────────────────────────────────┘
```

- **`src/orchestrator/router.ts`** — `planTask()` monta o plano de etapas por
  palavra-chave (função pura, sem I/O). `classifyTaskWithClaude()` é o
  roteador "leve via IA" usado só quando `--auto` está ativo e `planTask`
  não decidiu nada; faz uma chamada isolada ao `claude` e nunca é logada
  como etapa do pipeline.
- **`src/orchestrator/pipeline.ts`** — `runPipeline()` resolve o plano final
  (`--agent` força → senão `planTask` → senão `--auto` → senão o prompt
  interativo/erro) e roda cada etapa em sequência, repassando o output de
  uma etapa como `context` de entrada da próxima. Loga cada etapa (sucesso
  ou erro) no histórico.
- **`src/agents/`** — wrappers finos em volta de `execa` que disparam
  `claude -p "..."` e `agy -p "..." --print-timeout 3m`, com timeout
  configurável e tratamento consistente de erro (timeout, comando não
  encontrado, sessão expirada, exit code não-zero).
- **`src/storage/history.ts`** — persistência em SQLite
  (`~/.orquestrador/history.db`). Cada etapa grava `fed_by_step_id`
  apontando pro id da etapa anterior cujo output virou seu contexto —
  é o que permite reconstruir a cadeia de handoff depois, via
  `history --last`.
- **`src/cli.ts`** — entrypoint (`commander`) com os comandos `run` e
  `history`, spinner (`ora`) e cores (`chalk`).

## Testes

```bash
npm test          # roda a suíte (vitest run)
npm run test:watch
```

Os testes de `router.ts` e `pipeline.ts` mockam os wrappers de agente
(`src/agents/*.ts`) e o storage — a suíte **nunca chama `claude`/`agy` de
verdade**. Cobrem: as 4 combinações de roteamento por palavra-chave, as 3
classificações possíveis do `--auto` (mais falha e resposta inesperada),
`--agent` forçado, split com handoff de contexto, tarefa ambígua com e sem
resolvedor, cancelamento, e falha de agente propagando erro.

## Limitações conhecidas (MVP)

- `planTask` e `classifyTaskWithClaude` avaliam a tarefa inteira; não fazem
  split textual real de uma frase em pedaços — cada etapa recebe o texto
  integral do prompt original, o handoff é só de *output* entre etapas.
- Sem migração de schema no SQLite (mudança de schema exige apagar
  `~/.orquestrador/history.db` em bancos antigos).
- Execução sequencial, sem paralelismo entre agentes.
- `--dangerously-skip-permissions` do Claude Code nunca é habilitado por
  este projeto.

## Licença

[MIT](LICENSE)
