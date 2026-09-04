# orquestrador-cli

[![CI](https://github.com/joaopedroplinta/orquestrador-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/joaopedroplinta/orquestrador-cli/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/github/license/joaopedroplinta/orquestrador-cli)](LICENSE)

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

### Modo interativo (`orquestrador`, sem argumentos)

Rodar `orquestrador` sozinho, sem subcomando, abre uma tela interativa
(construída com [Ink](https://github.com/vadimdemedes/ink), a mesma lib por
trás da interface do Claude Code): digite uma tarefa, aperte Enter, veja o
spinner e o resultado aparecerem no transcript, e digite a próxima tarefa
sem sair do processo — tipo uma conversa.

```bash
orquestrador
```

Dentro da tela:

- Cada tarefa digitada roda pela mesma resolução de plano do `run` de uma
  tarefa só (`planTask` por palavra-chave; se ambígua, aparece um prompt
  pra escolher `claude`, `antigravity` ou `cancelar`, embutido na própria
  tela).
- `/history` — lista as execuções passadas (inclusive as da sessão atual,
  já que tudo é persistido normalmente em SQLite).
- `/exit` ou `/quit` — sai. `Ctrl+C` também sai a qualquer momento.
- Cada tarefa mostra logo abaixo qual agente foi roteado (`→ antigravity`
  ou `→ antigravity → claude`), e o spinner conta os segundos decorridos
  enquanto roda. Antigravity e Claude Code aparecem em cores diferentes e
  consistentes no transcript, pra escanear rápido quem fez o quê.

O que fica de fora da v1 (ver "Limitações" abaixo): sem streaming de output
ao vivo (mostra spinner até terminar, igual ao modo não-interativo), sem
rodar várias tarefas em paralelo dentro da tela, e sem `--agent`/`--auto`
como comandos de barra — pra isso, use `orquestrador run` diretamente.

### `orquestrador run "<tarefa>"`

Roda o fluxo completo pra uma tarefa — ou pra **várias tarefas independentes
ao mesmo tempo**, passando mais de um argumento (ver "Paralelismo" abaixo).
Por padrão, o roteamento de cada tarefa é decidido por palavra-chave no seu
texto:

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

orquestrador run "pesquisar a versão atual do TypeScript" "corrigir o typo no README"
# → duas tarefas independentes, cada uma roteada e executada em paralelo
#   (ver "Paralelismo" abaixo)
```

### Paralelismo: várias tarefas independentes

Passar mais de um argumento pra `run` roda cada tarefa **concorrentemente**
(cada `agy`/`claude` disparado é um processo de verdade rodando ao mesmo
tempo, não só uma simulação) — cada tarefa resolve seu próprio plano e gera
sua própria entrada no histórico, exatamente como se você tivesse rodado o
comando várias vezes em paralelo manualmente.

Isso só faz sentido quando as tarefas **não dependem uma da outra**. Dentro
de uma mesma tarefa que precisa de pesquisa *e* implementação (a linha
"ambos" da tabela acima), o handoff de contexto continua sequencial — o
Claude Code não pode começar antes de receber o resultado do Antigravity,
então essas duas etapas nunca rodam em paralelo entre si. O paralelismo é
só entre tarefas top-level que você lista separadamente na chamada.

Duas diferenças importantes em relação ao modo de uma tarefa só:

- **Sem fallback interativo.** Não dá pra abrir um prompt `readline` por
  tarefa concorrente sem confundir qual pergunta é de qual — então, com
  várias tarefas, uma tarefa ambígua que `--auto` não resolveu vira
  simplesmente um erro reportado *só pra ela*, sem derrubar as outras.
- **`--agent` e `--auto` se aplicam a todas as tarefas do lote igualmente**
  — não tem sintaxe pra forçar um agente diferente por tarefa individual.

```bash
orquestrador run "pesquisar X" "corrigir Y" "implementar Z"
# roda as três ao mesmo tempo; se "corrigir Y" falhar, "pesquisar X" e
# "implementar Z" ainda são reportadas normalmente
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
  de uma tarefa (`--agent` força → senão `planTask` → senão `--auto` →
  senão o prompt interativo/erro) e roda cada etapa em sequência,
  repassando o output de uma etapa como `context` de entrada da próxima.
  Loga cada etapa (sucesso ou erro) no histórico. `runPipelines()` roda
  várias tarefas independentes chamando `runPipeline()` uma vez por tarefa
  via `Promise.allSettled` — cada uma com seu próprio `runId`, sem afetar
  as outras se uma falhar.
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
  `history`, spinner (`ora`) e cores (`chalk`). Sem argumentos (zero
  subcomando), importa dinamicamente `src/tui/startTui.tsx` — quem só usa
  `run`/`history` não paga o custo de carregar Ink/React.
- **`src/tui/`** — tela interativa em Ink/React (`App.tsx` + `startTui.tsx`).
  Reaproveita `runPipeline()` e `listRuns()` sem alterar nada neles; tem sua
  própria versão do prompt de ambiguidade (via estado do React, não
  `readline`) porque Ink assume o controle do terminal.

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
resolvedor, cancelamento, falha de agente propagando erro, e `runPipelines`
(mapeamento tarefa → resultado, falha parcial isolada, tarefa ambígua no
lote virando erro pontual, e uma checagem de que a execução é concorrente de
verdade — tempo total bem abaixo da soma dos delays individuais).

## Limitações conhecidas (MVP)

- `planTask` e `classifyTaskWithClaude` avaliam a tarefa inteira; não fazem
  split textual real de uma frase em pedaços — cada etapa recebe o texto
  integral do prompt original, o handoff é só de *output* entre etapas.
- Sem migração de schema no SQLite (mudança de schema exige apagar
  `~/.orquestrador/history.db` em bancos antigos).
- Paralelismo é só entre tarefas top-level independentes (várias tarefas
  na mesma chamada de `run`); dentro de uma tarefa que gera handoff
  (pesquisa → implementação), a execução continua sequencial por design —
  há uma dependência real de dados ali, não dá pra paralelizar.
- Sem sintaxe pra forçar um agente diferente por tarefa individual no modo
  de várias tarefas — `--agent`/`--auto` valem pro lote inteiro.
- Modo interativo (`orquestrador` sem argumentos) não tem streaming de
  output ao vivo (spinner até terminar, igual ao `run`), não roda tarefas
  em paralelo dentro da tela, e não tem `/agent`/`/auto` como comandos de
  barra — só o prompt de ambiguidade existente.
- `--dangerously-skip-permissions` do Claude Code nunca é habilitado por
  este projeto.

## Licença

[MIT](LICENSE)
