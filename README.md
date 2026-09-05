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
output do agente aparecendo aos poucos no transcript enquanto ele roda, e
digite a próxima tarefa sem sair do processo — tipo uma conversa.

```bash
orquestrador
```

Dentro da tela:

- Cada tarefa digitada roda pela mesma resolução de plano do `run` de uma
  tarefa só (`planTask` por palavra-chave; se ambígua, aparece um prompt
  pra escolher `claude`, `antigravity` ou `cancelar`, embutido na própria
  tela) — a menos que `/agent` esteja forçando um agente (ver abaixo).
- `/history` — lista as execuções passadas (inclusive as da sessão atual,
  já que tudo é persistido normalmente em SQLite).
- `/exit` ou `/quit` — sai. `Ctrl+C` também sai a qualquer momento.
- `/agent claude` ou `/agent antigravity` — força esse agente pras
  **próximas tarefas digitadas** (equivalente ao `--agent` do modo CLI),
  até você trocar de novo ou rodar `/agent auto` pra voltar ao roteamento
  normal (por palavra-chave / `--auto`).
- `/auto` — liga/desliga a classificação automática via `claude` quando o
  roteamento por palavra-chave vem vazio (equivalente ao `--auto` do modo
  CLI). Independente de `/agent`: dá pra ter os dois ligados, ou só um.
- Um comando começando com `/` que não é nenhum desses (`/foo`) mostra uma
  mensagem de erro amigável — não trava a tela nem vira uma tarefa.
- O modo atual (`agente: automático` ou `agente: claude (forçado)`, e
  `auto: ligado`/`desligado`) fica sempre visível logo abaixo do
  transcript.
- Cada tarefa mostra logo abaixo qual agente foi roteado (`→ antigravity`
  ou `→ antigravity → claude`), e o spinner conta os segundos decorridos
  enquanto roda. Antigravity e Claude Code aparecem em cores diferentes e
  consistentes no transcript, pra escanear rápido quem fez o quê.
- **O output do agente aparece progressivamente enquanto ele roda**, não só
  no final. Isso é streaming *real* pro Antigravity (o `agy -p` escreve
  stdout aos poucos, conforme gera a resposta) — o Claude Code não faz
  isso em modo não-interativo (`claude -p` entrega tudo de uma vez, só
  quando termina), então pra ele a tela simula a revelação progressiva do
  texto já pronto, marcada com um `(simulando…)` ao lado do nome do
  agente pra não confundir com o streaming de verdade. Cada etapa de uma
  tarefa em duas partes (pesquisa → implementação) vira uma entrada do
  transcript assim que aquela etapa específica termina, sem esperar a
  outra.

**Múltiplas tarefas em paralelo, na mesma linha:** separe as tarefas por
`;` e aperte Enter uma vez só:

```
pesquisar a última versão do Node.js; implementar um endpoint de login
```

Cada tarefa do lote roda pelo mesmo `runPipelines()` usado pelo
`orquestrador run "<t1>" "<t2>"` não-interativo — de verdade em paralelo,
não uma esperando a outra. Na tela, cada tarefa ganha seu próprio bloco
rotulado `Tarefa i/N`, com o agente roteado e o streaming daquela tarefa
específica (real ou simulado, com `(simulando…)` quando for o caso)
aparecendo ali dentro, nunca misturado com o de outra tarefa do lote.
Assim que uma tarefa do lote termina, o resultado dela vira uma entrada
do transcript — não espera as outras.

**Tarefa ambígua dentro de um lote vira erro, não abre o prompt de
escolha** — a mesma regra que já vale pro `run` não-interativo com várias
tarefas: um prompt interativo não pode ficar esperando resposta pra uma
tarefa enquanto trava as outras do mesmo lote. A mensagem de erro indica
`/agent claude` ou `/agent antigravity` (ou reenviar essa tarefa sozinha,
fora do lote) como saída.

Uma linha sem `;`, ou com só uma parte não-vazia (`;` solto no final, por
exemplo), continua rodando como uma tarefa única normal.

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
  encontrado, sessão expirada, exit code não-zero). Aceitam um `onChunk`
  opcional ligado direto no stream de stdout do processo — só repassa o
  que o CLI subjacente realmente escreve, sem simular nada nesse nível.
- **`src/storage/history.ts`** — persistência em SQLite
  (`~/.orquestrador/history.db`). Cada etapa grava `fed_by_step_id`
  apontando pro id da etapa anterior cujo output virou seu contexto —
  é o que permite reconstruir a cadeia de handoff depois, via
  `history --last`.
- **`src/cli.ts`** — entrypoint (`commander`) com os comandos `run` e
  `history`, spinner (`ora`) e cores (`chalk`). Sem argumentos (zero
  subcomando), importa dinamicamente `src/tui/startTui.tsx` — quem só usa
  `run`/`history` não paga o custo de carregar Ink/React.
- **`src/tui/`** — tela interativa em Ink/React (`App.tsx` + `startTui.tsx`
  + `commands.ts` + `PromptInput.tsx`). Reaproveita `runPipeline()` e
  `listRuns()` sem alterar nada neles; tem sua própria versão do prompt de
  ambiguidade (via estado do React, não `readline`) porque Ink assume o
  controle do terminal. O input de texto (`PromptInput.tsx`) também é
  implementação própria, não `ink-text-input` — ver "Testes" abaixo. Pro
  streaming, `App.tsx` passa `onStepStart`/`onChunk`/`onStepComplete` pro
  `runPipeline()` e só acumula o que chega num estado local — a decisão de
  "é real ou simulado" já vem pronta do pipeline, a tela só exibe. Múltiplas
  tarefas na mesma linha (separadas por `;`) reaproveitam `runPipelines()`
  (o mesmo usado pelo `run "<t1>" "<t2>"` não-interativo) em vez de uma
  implementação paralela própria — só passa as versões com índice de
  tarefa dos três callbacks de streaming (`onTaskStepStart`/`onTaskChunk`/
  `onTaskStepComplete`), e nunca `resolveAmbiguousAgent` (tarefa ambígua
  no lote vira erro, não prompt).

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
resolvedor, cancelamento, falha de agente propagando erro, `runPipelines`
(mapeamento tarefa → resultado, falha parcial isolada, tarefa ambígua no
lote virando erro pontual, e uma checagem de que a execução é concorrente de
verdade — tempo total bem abaixo da soma dos delays individuais), e
streaming (chunks reais repassados sem passar pela simulação pro agente que
streama de verdade, a simulação reconstruindo o texto original sem perda
pro agente que não streama, e cada etapa virando uma entrada de resultado
assim que ela termina — sem esperar o resto do plano), e `runPipelines`
com streaming por índice de tarefa: `onTaskStepStart`/`onTaskChunk`/
`onTaskStepComplete` chegando com o índice certo pra cada tarefa do lote,
chunks de duas tarefas concorrentes (uma real via antigravity, outra
simulada via claude) não se misturando entre si, e tarefa ambígua no lote
virando erro em vez de abrir prompt mesmo com callbacks de streaming
presentes.

`src/tui/commands.ts` (o parsing de slash command, o parsing de `;` pra
múltiplas tarefas, e o estado de modo da TUI) também tem testes — é
lógica pura, sem depender de renderizar a tela de verdade: `/agent
claude|antigravity` forçando o agente, `/agent auto` resetando pro
roteamento normal, `/auto` alternando o estado, os dois sendo
independentes entre si, comando desconhecido/argumento inválido sempre
virando erro (nunca uma tarefa, nunca uma exceção), 2+ tarefas separadas
por `;` virando `{ kind: "tasks" }` com os textos aparados, e `;` solto
ou sobrando no final caindo de volta pro `{ kind: "task" }` original.

`src/tui/App.tsx` (o componente Ink em si) também tem cobertura, via
[`ink-testing-library`](https://github.com/vadimdemedes/ink-testing-library)
— renderiza a tela de verdade contra um stdin/stdout falso, mockando
`runPipeline`/`runPipelines`/`listRuns` (nunca chama `claude`/`agy`).
Cobre: o banner aparecendo uma única vez, o fluxo completo de uma tarefa
(spinner → resultado → input ativo de novo), o prompt de ambiguidade
embutido (escolher um agente e cancelar), os slash commands (`/agent`,
`/auto`, `/history`, comando desconhecido, `/exit`) refletindo na
`StatusLine` e no transcript, digitação em rajada sem nenhum caractere
perdido (a suíte inclui casos escrevendo vários caracteres seguidos, sem
esperar entre eles, especificamente pra provar isso — ver "input de texto
próprio" abaixo), e múltiplas tarefas via `;`: duas tarefas rodando em
paralelo com cada resultado aparecendo no bloco `Tarefa i/N` certo,
streaming intercalado de duas fontes aparecendo em caixas ao vivo
separadas sem misturar, e tarefa ambígua dentro do lote virando erro sem
nunca abrir o prompt embutido. `promptForAgent` (`src/cli.ts`, o fallback
interativo do modo não-TUI) continua sem teste automatizado — é
`readline` puro, sem a alternativa de um stdin falso.

O input de texto da TUI (`src/tui/PromptInput.tsx`) é implementação
própria, não a biblioteca `ink-text-input` — ela tinha um bug real de
perda de caractere em digitação rápida (o cálculo do próximo valor partia
de uma prop desatualizada quando duas teclas chegavam antes do React
re-renderizar entre uma e outra). `PromptInput` guarda o valor "de
verdade" numa `ref`, atualizada de forma síncrona a cada tecla, em vez de
depender do valor de um render anterior. Ver `CLAUDE.md` (bug #4) pro
histórico completo.

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
  de várias tarefas — `--agent`/`--auto` (CLI) e `/agent`/`/auto` (TUI)
  valem pro lote inteiro, tanto no `run "<t1>" "<t2>"` quanto no `;` da
  TUI.
- O streaming do Claude Code é sempre simulado (`(simulando…)`) — `claude
  -p` não escreve stdout de forma incremental em modo não-interativo,
  então não tem como ter streaming real dele hoje. Se isso mudar no
  futuro, é só atualizar `AGENT_STREAMS_INCREMENTALLY` em `types.ts`.
- `--dangerously-skip-permissions` do Claude Code nunca é habilitado por
  este projeto.

## Licença

[MIT](LICENSE)
