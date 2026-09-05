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
  CLI). Independente de `/agent`: dá pra ter os dois ligados, ou só um. Sem
  efeito com `/routing classify` (ver abaixo).
- `/routing keyword` ou `/routing classify` — equivalente ao `--routing` do
  modo CLI: troca a estratégia de roteamento inteira pras próximas tarefas.
  `classify` classifica toda tarefa via `claude`, mesmo uma com
  palavra-chave óbvia, pulando a tabela de palavra-chave inteiramente.
- Um comando começando com `/` que não é nenhum desses (`/foo`) mostra uma
  mensagem de erro amigável — não trava a tela nem vira uma tarefa.
- O modo atual (`agente: automático` ou `agente: claude (forçado)`,
  `roteamento: keyword`/`classify`, e `auto: ligado`/`desligado`) fica
  sempre visível logo abaixo do transcript.
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

**Agente diferente por tarefa dentro do lote:** prefixe qualquer tarefa
(no `;` ou digitada sozinha) com `claude:`/`antigravity:` — ver "Agente
por tarefa dentro de um lote" na seção do `run` mais abaixo pra sintaxe,
prioridade e exemplos completos.

### Retry automático em erros transitórios

Vale pra qualquer jeito de rodar uma tarefa (`run`, modo interativo,
lote com `;`): quando uma etapa falha por um erro que **pode** ser só um
solavanco momentâneo — timeout, sessão que expirou no meio da chamada,
ou um exit code não-zero sem cara de erro de sintaxe — o orquestrador
tenta de novo automaticamente antes de propagar o erro, com backoff
exponencial simples (1s, depois 2s, depois 4s...) e um máximo de 3
retries por padrão (a tentativa inicial não conta nesse número).

**Nem todo erro é retentado.** Comando não encontrado no PATH e
argumento/sintaxe inválido falham direto na primeira tentativa — repetir
não vai mudar o resultado, é sempre o mesmo erro de novo.

Enquanto isso acontece, você vê uma mensagem indicando que uma nova
tentativa está a caminho (pra não parecer que travou):

```
⟳ [antigravity] tentativa 1/3 falhou (timeout): "agy" excedeu o timeout de 180000ms — tentando de novo em 1000ms
```

No modo interativo, essa mensagem vira uma linha amarela no transcript
(com o prefixo `Tarefa i/N` quando a tarefa faz parte de um lote via `;`),
e o output ao vivo daquela etapa é reiniciado do zero na tentativa
seguinte. Cada tentativa que falhou também fica registrada no histórico
daquela etapa — `orquestrador history --last` mostra quantos retries uma
etapa precisou e por quê, não só o resultado final.

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
  do pipeline e não entra no histórico. Sem efeito quando `--routing=classify`
  (ver abaixo) — a classificação já sempre acontece nesse caso.
- **`--routing <keyword|classify>`** (padrão `keyword`) — troca a
  **estratégia** de roteamento inteira, não só o fallback de ambiguidade:
  - `keyword` (padrão): o comportamento de sempre — palavra-chave primeiro,
    `--auto` como fallback se não identificar nada.
  - `classify`: classifica **toda** tarefa via `claude` antes de rodar,
    mesmo uma com palavra-chave óbvia — pula a tabela acima inteiramente.
    Mais lento (uma chamada extra ao `claude` antes da etapa real), mas
    resolve tarefas sem nenhum sinal de palavra-chave sem precisar de
    `--auto` nem do prompt interativo.

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

orquestrador run "descreva rapidamente o conceito de recursão" --routing=classify
# → sem palavra-chave nenhuma (nem "pesquisar" nem "implementar"), mas
#   --routing=classify resolve mesmo assim, sem prompt interativo —
#   com o padrão (keyword) essa mesma tarefa cancelaria em stdin não-TTY

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
  — pra forçar um agente diferente por tarefa individual, use o prefixo
  `agente:` (ver abaixo).

```bash
orquestrador run "pesquisar X" "corrigir Y" "implementar Z"
# roda as três ao mesmo tempo; se "corrigir Y" falhar, "pesquisar X" e
# "implementar Z" ainda são reportadas normalmente
```

#### Agente por tarefa dentro de um lote (`agente:` no início da tarefa)

Prefixe uma tarefa individual com `claude:` ou `antigravity:` (dois pontos
logo depois do nome) pra forçar o agente **só daquela tarefa**, sem afetar
as outras do mesmo lote nem precisar de `--agent`/`--auto` global. Vale
tanto pro `run` com múltiplos argumentos quanto pro `;` da TUI (ver
"Modo interativo" acima).

```bash
# Dois agentes codificando em paralelo, cada um numa tarefa diferente —
# ambas as tarefas têm keyword de implementação, mas o prefixo decide:
orquestrador run "claude: implementar o endpoint de login" "antigravity: implementar a tela de cadastro"
```

```
# mesma ideia na TUI, numa linha só:
claude: implementar o endpoint de login; antigravity: implementar a tela de cadastro
```

O prefixo é removido antes do texto virar o prompt de verdade — o agente
recebe só "implementar o endpoint de login", não "claude: implementar...".
Sem prefixo, a tarefa continua caindo no roteamento de sempre (palavra-chave
ou `--auto`).

**Prioridade quando mais de uma coisa tenta decidir o agente:** `--agent`/
`/agent` **global** (vale pro lote inteiro) > **prefixo por tarefa** >
roteamento automático (palavra-chave / `--auto`). Ou seja, `--agent` global
sempre vence, mesmo se alguma tarefa tiver um prefixo diferente:

```bash
orquestrador run "claude: implementar X" "claude: implementar Y" --agent antigravity
# → as duas rodam no antigravity mesmo assim — --agent global sobrescreve o prefixo
```

Nome de agente inválido no formato de prefixo (`foo: implementar algo`) dá
um erro claro **só pra aquela tarefa** — `Prefixo de agente inválido:
"foo:"...` — sem derrubar as outras tarefas do lote.

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

**Tokens e custo, quando disponível:** o Claude Code expõe uso de tokens e
custo real em dólar (não uma estimativa nossa) via `--output-format json`.
Cada etapa rodada pelo `claude` mostra uma linha como:

```
tokens: entrada 2 · saída 105 · cache leitura 16777 · cache criação 47517 · custo US$ 0.19
```

e o topo do relatório mostra o custo total do run. **O Antigravity não
mostra custo** — ele também expõe tokens via `--output-format json`, mas
usar isso trocaria o streaming ao vivo dele (real) por uma resposta única
no final, então a decisão foi preservar o streaming e não coletar
tokens/custo dele. Quando nem toda etapa reporta custo, o resumo avisa que
é parcial (`(1/2 etapas reportaram custo — parcial)`) em vez de fingir que
é o total do run. Ver "Limitações conhecidas" pro detalhe completo.

### `orquestrador export <runId>`

Gera um **relatório em markdown** de uma execução do histórico — o que
cada agente fez, prompts, outputs completos, duração de cada etapa,
tokens/custo (quando disponível) e retries (quando houve):

```bash
orquestrador export c97f3333                          # imprime no stdout
orquestrador export c97f3333-a1c5-4099-9906-983b84440a49  # id completo também funciona
orquestrador export c97f3333 --output relatorio.md     # ou -o, salva num arquivo
```

`<runId>` aceita o id completo ou só o prefixo de 8 caracteres já mostrado
em `orquestrador history` (mesma ideia de hash curto do `git`). Se não
achar uma correspondência exata, tenta por prefixo e usa a execução mais
recente em caso de mais de uma bater. Um id que não existe retorna erro
com exit code 1, sem gerar nada.

## Arquitetura

```
  orquestrador run "<tarefa>"
       │
       ▼
┌────────────┐
│ router.ts  │  decide o plano (--routing=keyword: por
│ planTask() │  palavra-chave, --auto/prompt interativo
└────────────┘  como fallback; --routing=classify: via IA)
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
  roteador "via IA" — usado como estratégia primária inteira com
  `--routing=classify`, ou só como fallback de ambiguidade quando `--auto`
  está ativo e `planTask` não decidiu nada (`--routing=keyword`, o padrão);
  faz uma chamada isolada ao `claude` e nunca é logada como etapa do
  pipeline. `parseTaskAgentPrefix()` reconhece o prefixo `claude:`/
  `antigravity:` no início de uma tarefa.
- **`src/orchestrator/pipeline.ts`** — `runPipeline()` resolve o plano final
  de uma tarefa (`--agent` global → prefixo por tarefa → estratégia de
  roteamento `--routing` → prompt interativo/erro) e roda cada etapa em
  sequência, repassando o output de uma etapa como `context` de entrada da
  próxima. Loga cada etapa (sucesso ou erro) no histórico. `runPipelines()`
  roda várias tarefas independentes chamando `runPipeline()` uma vez por
  tarefa via `Promise.allSettled` — cada uma com seu próprio `runId`, sem
  afetar as outras se uma falhar.
- **`src/agents/`** — wrappers finos em volta de `execa` que disparam
  `claude -p "..."` e `agy -p "..." --print-timeout 3m`, com timeout
  configurável e tratamento consistente de erro (timeout, comando não
  encontrado, sessão expirada, exit code não-zero). Aceitam um `onChunk`
  opcional ligado direto no stream de stdout do processo — só repassa o
  que o CLI subjacente realmente escreve, sem simular nada nesse nível.
  `agents/shared.ts` (`runAgentCommand`) também é onde mora o retry
  automático: um loop de backoff exponencial em torno de uma única
  tentativa, que só repete erros classificados como transitórios
  (`RETRYABLE_AGENT_ERROR_KINDS` em `types.ts`) e devolve o histórico de
  tentativas que falharam (`retries`) junto do resultado final, seja
  sucesso ou erro. `agents/registry.ts` é a fonte única de "quais agentes
  existem" (`AGENT_REGISTRY`, `AGENT_NAMES`, `isAgentName()`) — pipeline,
  router, CLI e TUI leem de lá em vez de hardcodar os nomes; ver
  `CLAUDE.md` ("Adicionando um novo agente") pro passo a passo de estender
  isso pra um terceiro agente. `agents/claudeCode.ts` chama `claude -p`
  com `--output-format json` e faz o parsing do envelope pra extrair o
  texto de resposta e o uso de tokens/custo real — só ele, não o
  antigravity (ver "Limitações conhecidas" pro porquê).
- **`src/storage/history.ts`** — persistência em SQLite
  (`~/.orquestrador/history.db`). Cada etapa grava `fed_by_step_id`
  apontando pro id da etapa anterior cujo output virou seu contexto —
  é o que permite reconstruir a cadeia de handoff depois, via
  `history --last` —, `retries` (JSON com cada tentativa que falhou antes
  do resultado final daquela etapa), e `usage` (JSON com tokens/custo,
  quando o agente expõe isso). `getRunById(id)` busca uma execução por id
  completo ou prefixo de 8 caracteres, usado pelo `export`.
- **`src/reporting.ts`** — `buildMarkdownReport(run)`, função pura que
  monta o relatório markdown do `export` a partir de um `HistoryRun` — sem
  I/O nenhum, só formatação, testável com dados mockados.
- **`src/cli.ts`** — entrypoint (`commander`) com os comandos `run`,
  `history` e `export`, spinner (`ora`) e cores (`chalk`). Sem argumentos
  (zero subcomando), importa dinamicamente `src/tui/startTui.tsx` — quem
  só usa `run`/`history`/`export` não paga o custo de carregar Ink/React.
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
`parseTaskAgentPrefix` (prefixo `claude:`/`antigravity:` reconhecido e
removido do texto, case-insensitive, tolerando espaço antes do `:`, uma
frase comum com `:` no meio não sendo confundida com prefixo, e nome de
agente desconhecido no formato de prefixo sinalizado como inválido sem
alterar o texto), `--agent` forçado, split com handoff de contexto, tarefa
ambígua com e sem resolvedor, cancelamento, falha de agente propagando
erro, prefixo por tarefa (`claude:`/`antigravity:`) forçando o agente e
removendo o prefixo do prompt de verdade, `--agent` global sobrescrevendo
o prefixo por tarefa, e prefixo com nome de agente inválido lançando erro
claro sem chamar nenhum agente nem abrir run — no lote (`runPipelines`),
cada tarefa pode ter seu próprio prefixo independente das outras, e uma
tarefa com prefixo inválido vira um resultado de erro pontual sem afetar
as demais. Estratégia de roteamento: `--routing=keyword` (padrão) continua
chamando `planTask` primeiro sem nunca classificar, `--routing=classify`
pula `planTask` mesmo numa tarefa com palavra-chave óbvia, `--auto` fica
sem efeito extra com `--routing=classify` (nunca uma segunda classificação
redundante), classificação falhando com `--routing=classify` cai pro
resolvedor de ambiguidade igual ao fluxo padrão, `forceAgent` (global ou
prefixo) sempre tem prioridade sobre qualquer `--routing`, e o lote
(`runPipelines`) repassa a estratégia pra cada tarefa independentemente.
Uso de tokens/custo: `result.usage` é repassado pro histórico quando o
agente expõe isso, e uma etapa sem usage loga isso explicitamente como
ausente em vez de inventar um valor. `runPipelines`
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
simulada via claude) não se misturando entre si, tarefa ambígua no lote
virando erro em vez de abrir prompt mesmo com callbacks de streaming
presentes, e a integração de retry (`logStep` recebendo o array de
tentativas que falharam tanto no sucesso final quanto no erro esgotado,
`maxRetries`/`onRetry` repassados pro wrapper com o agente já amarrado, e
`onTaskRetry` chegando com o índice certo da tarefa do lote).

`src/agents/shared.test.ts` cobre o loop de retry em si (mockando
`execa`, sem chamar `claude`/`agy` de verdade): sucesso depois de 1 retry,
a sequência completa de backoff exponencial (1s, 2s, 4s) até o sucesso na
4ª tentativa, esgotamento de `maxRetries` propagando o erro final já com
o histórico de tentativas embutido, os dois casos de erro não-elegível
pra retry (comando não encontrado / argumento inválido) falhando direto
na primeira tentativa, e — a preocupação real por trás de rodar retries
dentro de um lote paralelo (`;` na TUI ou `run "<t1>" "<t2>"`) — dois
testes confirmando que o backoff de uma chamada não atrasa uma chamada
concorrente: um com timers falsos provando isso de forma determinística
(a chamada sem retry já resolveu antes do timer de 1s da outra sequer
disparar), e outro com timers de verdade medindo tempo de parede (a
chamada sem retry resolve em bem menos de 1s mesmo com a outra presa no
backoff, e o tempo total do par fica perto do delay de uma tarefa sozinha,
não da soma das duas).

`src/agents/registry.test.ts` cobre a estrutura do registro de agentes:
`AGENT_REGISTRY` tem exatamente as entradas claude/antigravity, cada
`runner` aponta pra mesma referência de função do wrapper de verdade,
`streamsIncrementally` reflete o probe manual documentado, `AGENT_NAMES`
é derivado das chaves do registro (não uma lista hardcoded separada), e
`isAgentName` reconhece os dois agentes e rejeita nomes desconhecidos.

`src/agents/claudeCode.test.ts` (mockando `execa`) cobre o parsing do
envelope `--output-format json`: chama o claude com a flag certa, extrai
o texto de resposta e o usage completo (tokens + custo real em USD) do
envelope, envelope sem usage/custo não quebra nada (campos ausentes em
vez de erro), e stdout que não é JSON válido (ou que é JSON mas sem o
campo `result` esperado) cai pro texto bruto sem lançar exceção.

`src/reporting.test.ts` cobre `buildMarkdownReport` com `HistoryRun`
mockado, sem nenhum SQLite de verdade envolvido: título/metadados/
contagem de etapas, formatação de duração, "alimentada pela etapa #N"
quando há handoff, execução não finalizada mostrando isso explicitamente,
etapa com erro mostrando o erro em vez do output, tabela de retries (com
`|` escapado numa mensagem), usage só com tokens não gerando linha de
custo, usage com custo aparecendo na etapa e no resumo do run, custo
abaixo de 1 centavo com mais casas decimais pra não virar US$ 0.00, e
custo parcial (só algumas etapas) avisando isso em vez de fingir que é o
total do run.

`src/tui/commands.ts` (o parsing de slash command, o parsing de `;` pra
múltiplas tarefas, e o estado de modo da TUI) também tem testes — é
lógica pura, sem depender de renderizar a tela de verdade: `/agent
claude|antigravity` forçando o agente, `/agent auto` resetando pro
roteamento normal, `/auto` alternando o estado, `/routing keyword|classify`
mudando a estratégia mantendo o resto do estado, os três sendo
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
próprio" abaixo), a prévia de rota (`→ agente`) respeitando um prefixo
`agente:` na tarefa mesmo quando a palavra-chave indicaria outro agente,
e múltiplas tarefas via `;`: duas tarefas rodando em paralelo com cada
resultado aparecendo no bloco `Tarefa i/N` certo, streaming intercalado de
duas fontes aparecendo em caixas ao vivo separadas sem misturar, tarefa
ambígua dentro do lote virando erro sem nunca abrir o prompt embutido, e
duas tarefas do mesmo lote com prefixos diferentes mostrando a prévia de
rota certa cada uma, mesmo com a mesma palavra-chave nas duas; e
`/routing`: muda a estratégia e reflete na `StatusLine` sem afetar
`/agent`/`/auto` já setados, argumento inválido mostra erro sem mudar o
estado, e uma tarefa rodada depois chega em `runPipeline` com a estratégia
certa de verdade (não só na exibição).
`promptForAgent` (`src/cli.ts`, o fallback
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
- Sem sistema de migração de schema no SQLite de verdade — em geral, uma
  mudança de schema exige apagar `~/.orquestrador/history.db` em bancos
  antigos. A coluna `retries` foi a única exceção (migração pontual e
  guardada, não um mecanismo genérico).
- Retry automático não tenta de novo `PipelineCancelledError` nem erro de
  roteamento ambíguo — só erros de execução do agente (`AgentError`) que
  parecem transitórios. O número de retries (`maxRetries`, padrão 3) e o
  backoff (1s/2s/4s, dobrando a cada tentativa) não são configuráveis via
  flag do CLI ainda — só por quem chama `runPipeline`/`runPipelines`
  programaticamente.
- A heurística que separa "argumento inválido" (não retenta) de "exit code
  momentâneo" (retenta) é baseada em palavras comuns no stderr ("unknown
  option", "usage:", etc.) — **nunca foi validada contra a mensagem real**
  que `claude -p`/`agy -p` produzem pra um argumento inválido de verdade.
  Pode ter falso positivo (um log de diagnóstico não relacionado que
  contenha uma dessas palavras, ex. "usage:" numa mensagem sobre uso de
  memória, cancelando um retry que deveria ter acontecido) ou falso
  negativo (uma mensagem de erro num formato que a heurística não
  reconhece, cai em `nonzero_exit` genérico e é retentada à toa — pior
  caso, ~7s de atraso extra, não perda de dados). Na prática baixo risco
  hoje: os argumentos passados pros dois CLIs são fixos nos wrappers, o
  texto da tarefa nunca é reinterpretado como flag.
- **Tokens/custo só são rastreados pro Claude Code** — o Antigravity
  também expõe isso via `--output-format json` (confirmado, não é falta de
  suporte no CLI dele), mas usar essa flag trocaria o streaming real dele
  por uma resposta única no final; a decisão foi preservar o streaming.
  Além disso, a chamada de classificação de `--routing=classify`/`--auto`
  também gasta tokens/custo de verdade (usa o claude por baixo), mas como
  ela nunca é logada como etapa do pipeline, esse custo não aparece em
  lugar nenhum — não é uma quantia grande (prompt curto), mas é real.
  `history --last`/`export` só mostram custo por execução — sem uma visão
  agregada de custo total ao longo do tempo.
- `--routing=classify` classifica em só três categorias fixas
  ("pesquisa"/"implementação"/"ambos", mapeadas pra antigravity/claude/os
  dois) — um terceiro agente adicionado ao registro (ver "Arquitetura") não
  passa a ser considerado pela classificação automaticamente, precisaria
  reescrever o prompt de classificação. `--auto`/`/auto` ligado junto com
  `--routing=classify` não avisa que ficou sem efeito (é ignorado
  silenciosamente, não um erro).
- Paralelismo é só entre tarefas top-level independentes (várias tarefas
  na mesma chamada de `run`); dentro de uma tarefa que gera handoff
  (pesquisa → implementação), a execução continua sequencial por design —
  há uma dependência real de dados ali, não dá pra paralelizar.
- O prefixo `agente:` por tarefa (ver "Agente por tarefa dentro de um lote"
  acima) reconhece só um token único logo no início, seguido de `:` — uma
  tarefa que legitimamente começa com "palavra: resto" sem ter nada a ver
  com escolha de agente (ex.: "TODO: revisar X", "obs: lembrar de Y") vai
  ser interpretada como uma tentativa de prefixo e dar erro de "agente
  inválido" em vez de rodar normal. Contorno: reformule a tarefa pra não
  começar exatamente nesse formato, ou use `--agent`/`/agent` global.
- O streaming do Claude Code é sempre simulado (`(simulando…)`) — `claude
  -p` não escreve stdout de forma incremental em modo não-interativo,
  então não tem como ter streaming real dele hoje. Se isso mudar no
  futuro, é só atualizar `AGENT_REGISTRY.claude.streamsIncrementally` em
  `src/agents/registry.ts`.
- `--dangerously-skip-permissions` do Claude Code nunca é habilitado por
  este projeto.

## Licença

[MIT](LICENSE)
