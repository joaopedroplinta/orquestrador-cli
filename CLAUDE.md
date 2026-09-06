# CLAUDE.md

Orquestrador CLI para Claude Code + Antigravity. **MVP completo** — ver
`README.md` na raiz pra documentação de uso/arquitetura voltada a quem só
quer rodar o CLI; este arquivo é o contexto de trabalho pra quem vai mexer
no código.

## Visão geral

CLI em Node.js que orquestra duas ferramentas de IA agentic (Claude Code e
Antigravity CLI/`agy`) trabalhando juntas numa mesma tarefa: decide qual
agente cuida de qual parte, dispara os comandos via shell e repassa o
resultado de um como contexto de entrada pro outro.

Fluxo básico:

1. Usuário roda `orquestrador run "tarefa aqui"` (ou várias tarefas de uma
   vez — `run "tarefa1" "tarefa2"` roda cada uma concorrentemente, ver
   "Paralelismo" nas convenções abaixo).
2. Roteamento decide o plano de etapas de cada tarefa, nesta ordem de prioridade:
   `--agent` global (força um agente pro lote inteiro, pula tudo) → prefixo
   `agente:` por tarefa (`"claude: implementar X"` força só aquela tarefa,
   ver Convenções) → estratégia de roteamento (`--routing`, padrão
   `"keyword"`): `planTask` por palavras-chave → `--auto` (classificação
   leve via `claude`, só se a keyword veio vazia) → prompt interativo no
   terminal (só se os anteriores não resolveram) → erro/cancelamento. Com
   `--routing=classify`, a classificação via `claude` substitui `planTask`
   inteiramente (roda sempre, não só como fallback de ambiguidade).
3. Dispara cada etapa do plano via shell:
   - `agy -p "..." --print-timeout 3m` — Antigravity, pra pesquisa/contexto/web search.
   - `claude -p "..."` — Claude Code, pra implementação/refatoração de código.
4. O output de uma etapa vira parte do prompt da próxima (handoff de contexto).
5. Cada etapa é logada (agente usado, prompt enviado, output recebido,
   timestamp, duração, e qual etapa anterior alimentou seu contexto).
6. No final, exibe um resumo no terminal com o que cada agente fez.

## Stack

- **Node.js + TypeScript**
- **CLI framework:** `commander`
- **Execução de shell:** `execa`
- **Persistência do histórico:** `better-sqlite3`
- **Output no terminal (modo não-interativo):** `chalk` (cores) + `ora` (spinners)
- **Tela interativa (`src/tui/`):** `ink` + `react` (`ink-spinner`; o input de
  texto é próprio — `PromptInput.tsx` — não usa `ink-text-input`, ver
  Convenções abaixo)
- **Testes:** `vitest` (+ `ink-testing-library` pra renderizar a TUI em teste)

## Comandos

```bash
npm install          # instala dependências
npm run build        # compila TypeScript (tsconfig.build.json, sem *.test.ts) pra dist/
npm run dev           # roda o CLI em modo dev (tsx)
npm test             # roda a suíte de testes (vitest run)
npm run test:watch   # vitest em modo watch
npm link             # expõe o binário `orquestrador` localmente pra testar

orquestrador run "<tarefa>"              # roda o fluxo completo
orquestrador run "<tarefa>" --agent claude|antigravity   # força o agente
orquestrador run "<tarefa>" --auto       # classifica via claude se ambígua (routing=keyword)
orquestrador run "<tarefa>" --routing=classify  # classifica TODA tarefa via claude, sem tentar keyword antes
orquestrador run "<tarefa1>" "<tarefa2>" # roda várias tarefas independentes em paralelo
orquestrador history                     # lista execuções passadas (só do projeto atual, se houver .orquestradorrc por perto)
orquestrador history --all               # ignora o filtro por projeto, mostra o histórico global
orquestrador history --last              # mostra detalhes da última execução (com tokens/custo, se houver)
orquestrador export <runId>              # relatório em markdown de um run (id completo ou prefixo de 8 chars)
orquestrador export <runId> -o out.md    # escreve o relatório num arquivo em vez do stdout
orquestrador                             # zero args: abre a tela interativa (Ink)
orquestrador --no-mascot                 # idem, mas sem o pinguim ASCII (também dá pra alternar com /mascot dentro da tela)
```

`.orquestradorrc` (JSON, opcional, na raiz de um projeto) configura
`agent`/`routing`/`auto`/`maxRetries`/`retryBaseDelayMs`/`mascot` por
projeto — ver Convenções abaixo pro discovery/precedência completos.

## Convenções

- **Nomes de arquivo em camelCase** (`claudeCode.ts`, `history.ts`), não kebab-case.
- **Imports relativos dentro de `src/`**, sem path aliases no MVP.
- **Erros de wrapper de agente** (timeout, comando não encontrado, sessão
  expirada) são capturados no próprio wrapper (`src/agents/*.ts`) e
  propagados como um tipo de erro específico — nunca deixar o processo
  do CLI morrer com stack trace cru de `execa`.
- **Timeout generoso (3–5 min)** em toda chamada de agente que vira etapa do
  pipeline. A chamada de classificação do `--auto` usa um timeout curto
  (30s) porque é só uma resposta de uma palavra, não uma etapa agentic.
- **Nunca habilitar `--dangerously-skip-permissions`** fora de ambiente
  controlado — auto-aprova tool calls sem confirmação.
- **O orquestrador nunca lida com login/credenciais** — assume que `claude`
  e `agy` já estão autenticados na máquina.
- **Paralelismo é só entre tarefas top-level independentes**, nunca dentro
  do handoff de uma mesma tarefa: `runPipelines()` (`src/orchestrator/pipeline.ts`)
  chama `runPipeline()` uma vez por tarefa via `Promise.allSettled` — cada
  tarefa gera seu próprio `runId`/steps. Dentro de uma tarefa que gera 2
  etapas (pesquisa → implementação), a execução continua sequencial porque
  há dependência real de dados (a segunda precisa do output da primeira).
  Nunca introduzir paralelismo onde há handoff de contexto.
- **Modo de várias tarefas não usa o fallback interativo** — não dá pra
  abrir vários prompts `readline` concorrentes sem confundir qual pergunta
  é de qual. Uma tarefa ambígua nesse modo vira só um resultado de erro pra
  ela (via `Promise.allSettled`), sem derrubar as outras tarefas do lote.
- Sem interface gráfica — só CLI.
- Sem multi-tenant / múltiplos usuários.
- **Testes ficam colocados junto do arquivo testado** (`router.test.ts` ao
  lado de `router.ts`), não numa pasta `tests/` separada. `tsconfig.build.json`
  exclui `*.test.ts` do build de produção; `tsconfig.json` (usado por editor
  e `tsc --noEmit`) continua incluindo os testes pro type-check completo.
- **Testes de `router.ts`/`pipeline.ts` mockam os wrappers de agente e o
  storage** (`vi.mock` em `../agents/*.js` e `../storage/history.js`) —
  nunca chamam `claude`/`agy` de verdade. Testes de integração real
  (chamando os CLIs de verdade) são só validação manual, não fazem parte
  da suíte automatizada.
- **A chamada de classificação do `--auto` (`classifyTaskWithClaude`) não é
  uma etapa do pipeline** — não passa por `logStep`/histórico. Só o plano de
  etapas que ela produz (quando classifica com sucesso) vira etapas reais.
- **`src/tui/` nunca usa `ora`/`readline`** — Ink assume o controle do
  terminal (raw mode), e misturar com essas libs corrompe a tela. A TUI
  reimplementa o prompt de ambiguidade como componente React (estado +
  `PromptInput`), chamando `runPipeline()` com um `resolveAmbiguousAgent`
  próprio; o resto (`agents/`, `router.ts`, `pipeline.ts`, `storage/`) é
  100% reaproveitado sem alteração.
- **O input de texto da TUI é próprio (`src/tui/PromptInput.tsx`), não
  `ink-text-input`** — motivo é um bug real de perda de caractere (ver bug
  #4 abaixo), não preferência estética. **Nunca compute o próximo valor do
  input a partir de uma prop/estado vindo do último render** (ex.:
  `value.slice(...) + charDigitado`) — se duas teclas chegarem rápido
  demais pro React re-renderizar entre uma e outra, o segundo cálculo
  enxerga um valor desatualizado e descarta a primeira tecla. O valor
  "de verdade" mora numa `ref` (`valueRef`), mutada de forma síncrona a
  cada tecla; o `useState` (`display`) existe só pra disparar o
  re-render, sempre lendo o valor JÁ ATUALIZADO da ref, nunca calculando
  algo incrementalmente por conta própria. Esse padrão vale pra qualquer
  handler de teclado futuro na TUI, não só o input de texto.
- **Parsing de slash command da TUI fica em `src/tui/commands.ts`, separado
  de `App.tsx`** — é lógica pura (sem Ink/React), testada isoladamente em
  `commands.test.ts`. `App.tsx` só chama `parseInput()`/`applyModeCommand()`
  e reage ao resultado; nunca reimplementar essa lógica de decisão inline
  no componente.
- **`App.tsx` tem cobertura via `ink-testing-library`** (`App.test.tsx`) —
  renderiza o componente de verdade contra um stdin/stdout falso, mockando
  `runPipeline`/`listRuns`. Ao simular digitação, cada caractere precisa de
  um `tick` (`setTimeout(resolve, 0)`) antes do próximo — escrever vários
  caracteres no stdin falso no mesmo tick reproduz o mesmo bug de "colar
  texto" que já vimos com PTY real (ver bug #3 abaixo), inclusive perdendo
  caracteres no meio de uma string digitada rápido demais.
- **`forcedAgent` e `autoMode` (estado de modo da TUI) são independentes**
  — `/agent claude` liga um sem mexer no outro, `/auto` liga o outro sem
  mexer no `forcedAgent`. Mesma prioridade do modo CLI: se `forcedAgent`
  estiver setado, ele sempre vence (`runPipeline({ forceAgent, auto })` —
  `forceAgent` tem prioridade sobre `auto` dentro do próprio `pipeline.ts`,
  não precisa reforçar isso na TUI).
- **`cli.ts` carrega `src/tui/startTui.tsx` via `import()` dinâmico**, só
  quando invocado sem argumentos — quem usa `run`/`history` não paga o
  custo de carregar Ink/React.
- **`render()` da TUI usa `{ incrementalRendering: true }`** (obrigatório,
  não é só otimização cosmética) — sem isso, o Ink redesenha a árvore
  inteira a cada tecla; com caixas de borda ocupando a largura toda do
  terminal, isso gera volume de output grande o bastante pra estourar o
  buffer do pty em rajadas de digitação rápida (`Error: write EIO`,
  descoberto testando com PTY real via `pexpect`). Qualquer novo elemento
  visual "pesado" na TUI (bordas largas, muito texto por frame) deve levar
  isso em conta — inclusive o streaming (ver abaixo), que foi
  re-validado especificamente contra esse risco.
- **Streaming de output é real pro `antigravity`, simulado pro `claude`** —
  confirmado com um probe manual (`spawn` + log de timing dos chunks de
  stdout, ver "Estado atual"): `agy -p` escreve aos poucos conforme gera a
  resposta; `claude -p` entrega tudo num chunk só, no final. A flag
  `streamsIncrementally` em `AGENT_REGISTRY` (`agents/registry.ts`) registra
  isso por agente. `runAgentCommand` (`src/agents/shared.ts`) só liga um `onChunk` de
  verdade no stdout do `execa` — não inventa nada. Quem decide *fingir*
  streaming pra um agente que não escreve incremental é
  `simulateStreamingReveal()` em `pipeline.ts`, claramente separada e
  comentada como fallback visual — nunca colocar essa lógica dentro do
  wrapper do agente nem fingir que é dado real.
- **Retry automático com backoff mora em `runAgentCommand` (`src/agents/
  shared.ts`), não em `pipeline.ts`.** É o lugar que já classifica o erro
  em `AgentError`/`AgentErrorKind`, então é ali que sabe se aquele erro
  específico vale a pena repetir. `RETRYABLE_AGENT_ERROR_KINDS` (`types.ts`)
  é a lista central de quais `AgentErrorKind` são elegíveis — hoje:
  `timeout`, `auth_expired`, `nonzero_exit`, `unknown`. **Não** são
  elegíveis: `command_not_found` (o binário não vai aparecer no PATH numa
  segunda tentativa) e `invalid_argument` (um argumento inválido vai dar o
  mesmo erro de novo, é sintaxe errada, não sorte). `invalid_argument` é
  detectado por uma heurística de texto no stderr (`looksLikeInvalidArgumentError`
  — "unknown option", "invalid argument", "usage:", etc.) que roda ANTES da
  classificação genérica `nonzero_exit`, senão todo argumento inválido cairia
  ali e seria retentado à toa. **Essa heurística é um chute educado, não
  validado contra o texto real que `claude -p`/`agy -p` produzem pra um
  argumento inválido de verdade** (nunca fizemos o probe manual — tipo o
  que existe pro streaming — de forçar esse erro nos dois CLIs e ver a
  mensagem exata; os padrões vêm de convenção comum de ferramentas
  estilo getopt/git/npm). Riscos conhecidos, documentados aqui em vez de
  escondidos:
  - **Falso positivo**: qualquer stderr que contenha um desses termos por
    coincidência, mesmo sem ser sobre argumento — o mais preocupante é
    `"usage:"`, que é curto e genérico o bastante pra aparecer em log de
    diagnóstico não relacionado (ex.: uma linha de "resource usage:" antes
    de um crash por falta de memória, que na verdade é um erro transitório
    e deveria ser retentado). Isso classificaria como `invalid_argument` e
    pularia o retry indevidamente.
  - **Falso negativo**: se `claude`/`agy` usarem uma frase diferente pra
    reportar argumento inválido (formato próprio, mensagem em outro idioma,
    JSON estruturado em vez de texto livre), a heurística não reconhece e o
    erro cai no `nonzero_exit` genérico — sendo retentado à toa até 3 vezes
    antes de falhar (pior caso: ~7s de atraso extra, não perda de dados).
  - Na prática, o único jeito de `invalid_argument` disparar hoje é um bug
    nos nossos próprios wrappers (`claudeCode.ts`/`antigravity.ts` passam
    args fixos, nunca derivados livremente do texto da tarefa) — o texto do
    usuário vira um único argumento de `execa` (nunca reinterpretado por um
    shell), então não é um vetor realista de acionar isso. Se algum dia
    isso mudar (novos args configuráveis pelo usuário), vale então fazer o
    probe manual real e calibrar a heurística contra os dois CLIs de
    verdade.
  Backoff exponencial simples: `1000 * 2^(tentativa-1)`
  ms (1s, 2s, 4s, ...), `maxRetries` (padrão 3, contando só os retries — a
  tentativa inicial não conta) configurável via `AgentRunOptions.maxRetries`
  → `RunPipelineOptions.maxRetries`/`RunManyOptions.maxRetries`. Nunca fazer
  retry de erro de roteamento (`PipelineCancelledError`, ambiguidade) — isso
  não passa nem perto do `runAgentCommand`, é decidido antes, em `pipeline.ts`.
- **Cada tentativa que falhou fica registrada, não só a última.** A etapa
  bem-sucedida (ou o erro final, se esgotar `maxRetries`) carrega um array
  `retries: AgentRetryAttempt[]` (`{ attempt, kind, message, delayMs,
  timestamp }`) com uma entrada por tentativa que falhou antes daquele
  resultado — `AgentRunResult.retries` no caminho de sucesso,
  `AgentError.retries` no caminho de erro esgotado (o próprio
  `runAgentCommand` reconstrói o `AgentError` final já com o array
  completo embutido antes de propagar). `pipeline.ts` repassa isso pro
  `logStep()` como está, sem transformar. `storage/history.ts` serializa
  `retries` como JSON numa coluna `retries TEXT` nullable — **sem sistema de
  migração de verdade no projeto** (ver Pendências), então essa coluna
  específica foi adicionada com uma migração mínima e guardada
  (`ensureRetriesColumn`: `PRAGMA table_info` + `ALTER TABLE ... ADD COLUMN`
  só se a coluna ainda não existir) pra não quebrar/exigir apagar bancos
  `~/.orquestrador/history.db` já existentes — validado manualmente criando
  um banco com o schema antigo (sem a coluna) e confirmando que `history
  --last` lê normal depois de abrir o app uma vez. Visibilidade: `onRetry`
  é o quarto callback de streaming (`onStepStart`/`onChunk`/`onStepComplete`/
  `onRetry`) em `RunPipelineOptions`, repassado com o agente já amarrado
  (`(agent, info) => ...`); em `RunManyOptions` vira `onTaskRetry` com o
  índice da tarefa também amarrado, mesmo padrão dos outros três. `cli.ts`
  imprime a tentativa (`⟳ [agente] tentativa X/N falhou (kind): msg —
  tentando de novo em Yms`) tanto no modo de uma tarefa quanto no paralelo,
  e `history --last` mostra quantos retries uma etapa passada precisou. A
  TUI (`App.tsx`) vira uma entrada `kind: "retry"` no transcript (persiste
  no scrollback, com `batchPrefix` no modo `;`) e limpa o buffer de
  streaming ao vivo daquela etapa (`setStreamingOutput("")` /
  `streamingOutput: ""` no `LiveTask`) antes da próxima tentativa começar —
  senão o output parcial de uma tentativa que falhou ficaria colado no
  início do resultado da tentativa seguinte.
- **Prefixo `agente:` por tarefa mora em `parseTaskAgentPrefix`
  (`src/orchestrator/router.ts`), consumido dentro de `runPipeline()`
  (`pipeline.ts`) — não em `runPipelines()`.** Como `runPipelines` já
  delega cada tarefa do lote pra uma chamada independente de
  `runPipeline()`, colocar o parsing ali dentro faz ele "só funcionar"
  tanto pro `run "<t1>" "<t2>"` quanto pro `;` da TUI quanto pra uma
  tarefa única digitada sozinha, sem duplicar lógica em três lugares.
  Regex: `^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*` — só reconhece um token único
  logo no início seguido de `:` (com `\s*` só entre o token e o `:`, nunca
  dentro dele), então uma frase comum como "corrigir bug: o app trava" não
  ativa isso (o `:` só aparece depois de duas palavras). Prioridade,
  aplicada dentro de `runPipeline()`: `options.forceAgent` (--agent/`/agent`
  **global**, vale pro lote inteiro) `??` `prefix.agent` (por tarefa) — se
  nenhum dos dois, cai no `planTask`/`--auto`/resolver de sempre. O prefixo
  é **sempre** parseado e removido do texto antes de virar prompt/ir pro
  histórico, mesmo quando `forceAgent` global vai acabar sobrescrevendo o
  agente escolhido por ele — evita comportamento inconsistente (o mesmo
  texto de tarefa se comportando diferente, ou vazando o prefixo pro
  agente, dependendo de flags não relacionadas). Nome de agente
  desconhecido no formato de prefixo (`"foo: implementar X"`) joga um
  `Error` comum (mesmo estilo do erro de tarefa ambígua sem resolvedor,
  não um `AgentError` — não é uma falha de execução do agente, é a tarefa
  chegando malformada) **antes** de `startRun()`/qualquer chamada de
  agente — dentro de `runPipelines()`, isso vira só um resultado de erro
  pontual daquela tarefa via `Promise.allSettled`, igual qualquer outro
  erro de `runPipeline()`, sem precisar de tratamento especial. **Trade-off
  aceito conscientemente**: qualquer tarefa que legitimamente comece com
  "palavra-única: resto" sem relação com escolha de agente (`"TODO: revisar
  X"`, `"obs: lembrar Y"`) vai ser interpretada como tentativa de prefixo e
  dar erro de "agente inválido" em vez de rodar normal — documentado como
  limitação conhecida (README/Pendências), não um bug.
  `App.tsx` (TUI) tem sua própria cópia dessa prioridade só pra prévia de
  rota mostrada ANTES do pipeline rodar de verdade (`previewAgents()`) —
  puramente cosmético/síncrono (não pode chamar `runPipeline` só pra saber
  o que vai rodar), então duplica a leitura de `forceAgent ?? prefix.agent
  ?? planTask(...)`, mas nunca decide o agente de verdade; quem decide é
  sempre `runPipeline()`.
- **Estratégia de roteamento (`RoutingStrategy` em types.ts) é ortogonal à
  prioridade de agente forçado — só entra em jogo quando não há
  `forceAgent` (nem global nem por prefixo).** `"keyword"` (padrão) é
  exatamente o comportamento de sempre: `planTask()` primeiro, `--auto`
  como fallback pra `classifyTaskWithClaude()` só se a keyword não decidiu
  nada. `"classify"` **pula `planTask()` inteiramente** — toda tarefa vira
  uma chamada de classificação, mesmo uma com keyword óbvia (`"implementar
  X"`) — é uma escolha deliberada, não um fallback: o usuário está dizendo
  "não confia no roteamento por palavra-chave pra isso, sempre pergunta pro
  claude". Implementado dentro de `runPipeline()` (não em `runPipelines()`,
  mesma lógica do prefixo por tarefa) via um `if/else if/else` — nunca um
  `switch` exaustivo, porque só tem dois ramos reais hoje (`forceAgent` já
  curto-circuita antes). `--auto`/`/auto` **não tem efeito quando
  `routing === "classify"`** — a classificação já é sempre a única
  tentativa, então repeti-la de novo como "fallback" seria uma segunda
  chamada idêntica e inútil; a UI (CLI e TUI) não impede passar os dois
  juntos, só documenta que `--auto` fica sem efeito extra nesse caso.
- **`agents/registry.ts` é a única fonte de verdade de "quais agentes
  existem de verdade" pro resto do sistema — `pipeline.ts`, `router.ts`,
  `cli.ts` e a TUI leem de lá em vez de hardcodar `"claude"`/`"antigravity"`
  nas próprias listas.** `AGENT_REGISTRY: Record<AgentName, AgentDefinition>`
  substitui o que antes eram DUAS estruturas paralelas mantidas à mão
  (`RUNNERS` em `pipeline.ts` + `AGENT_STREAMS_INCREMENTALLY` em
  `types.ts`) — cada `AgentDefinition` já carrega o `runner` (a função que
  dispara o processo) e o `streamsIncrementally` juntos, então não tem como
  esquecer de atualizar um sem o outro. `AGENT_NAMES` (array) e
  `isAgentName()` (type guard) são derivados do registro — `cli.ts`
  (`--agent`), `commands.ts` (`/agent`) e `router.ts` (prefixo por tarefa)
  usam esses dois em vez de comparar contra `"claude"`/`"antigravity"`
  literalmente, então um agente novo passa a ser aceito automaticamente
  nessas três validações sem tocar nelas. Ver "Adicionando um novo agente"
  abaixo pro que ainda precisa de edição manual (e por quê).
- **Uso de tokens/custo (`AgentUsage` em types.ts) só existe pro claude,
  de propósito — confirmado via probe manual, não suposto** (mesmo
  princípio do probe de streaming: nunca assumir, sempre medir). Achados:
  - `claude -p --output-format json` devolve um envelope JSON com o texto
    de resposta em `.result` e uso REAL (não estimado) em `.usage`/
    `.total_cost_usd` — inclusive custo em dólar já calculado pelo
    próprio CLI. Como `claude -p` nunca streama de verdade
    (`AGENT_REGISTRY.claude.streamsIncrementally === false`), trocar pra
    `--output-format json` não custa NADA em termos de streaming — não
    tinha streaming real pra perder.
  - `agy -p --output-format json` **também** expõe uso de tokens
    (`usage.input_tokens`/`output_tokens`/etc.), mas isso tem um custo
    real: um probe cronometrando os chunks de stdout mostrou que o modo
    json faz o antigravity parar de streamar de verdade — o texto inteiro
    chega num chunk só, no final (~7.3s de silêncio, depois tudo de uma
    vez), igual ao modo json do claude. Como o antigravity é o único
    agente com streaming real hoje (feature já construída, testada e
    documentada — PR de streaming), a decisão foi **priorizar preservar
    o streaming em vez de ganhar tracking de uso pro antigravity** —
    `agents/antigravity.ts` continua em modo texto puro, sem
    `--output-format json`, e por isso nunca popula `AgentRunResult.usage`.
    Trade-off documentado, não uma limitação técnica sem solução (ver
    Pendências pra alternativas não implementadas, tipo `stream-json`).
  - Também investigado e descartado: `agy --log-file` como canal
    alternativo pra pegar usage sem mexer no stdout — o log gerado é só
    ruído de diagnóstico interno (erros de polling de auth, etc.),
    nenhuma menção a tokens/usage/custo nele.
  - `runClaudeCode` (`agents/claudeCode.ts`) faz o parsing do envelope
    JSON isolado ali dentro (`parseClaudeJsonEnvelope`) — `agents/shared.ts`
    (`runAgentCommand`) continua 100% genérico, sem saber que existe
    formato JSON nenhum; se o parsing falhar por qualquer motivo (CLI
    mudou de formato, por exemplo), cai pro texto bruto sem usage em vez
    de quebrar a etapa inteira — usage é sempre um extra, nunca algo de
    que o resto do pipeline dependa. `pipeline.ts` só repassa
    `result.usage` pro `logStep()` como está, mesmo padrão de `retries`.
    `storage/history.ts` serializa como JSON numa coluna `usage TEXT`
    nullable, com a mesma migração pontual e guardada
    (`ensureColumn(db, "usage")`, generalizado a partir do
    `ensureRetriesColumn` original pra aceitar qualquer nome de coluna).
  - **Nunca inventamos um custo pro antigravity** — sem preço por token
    conhecido/confiável, um número calculado por nós seria uma estimativa
    não confiável, exatamente o que foi pedido pra evitar. `history --last`
    e o relatório de `export` mostram os tokens do antigravity quando
    existirem, mas nunca um "custo estimado" pra ele.
- **`orquestrador export <runId>`** (`src/reporting.ts` +
  `storage/history.ts`'s `getRunById`) gera um relatório em markdown de
  uma execução — `buildMarkdownReport(run: HistoryRun): string` é uma
  função pura (sem I/O), testada com dados mockados
  (`reporting.test.ts`), sem depender do SQLite de verdade.
  `getRunById(id)` aceita tanto o UUID completo quanto o prefixo de 8
  caracteres já mostrado em `history` (mesma convenção de hash curto do
  git) — tenta bater exato primeiro, senão cai pro prefixo, pegando a
  execução mais recente em caso de ambiguidade (nunca erro de "múltiplas
  correspondências", só resolve pra mais recente). `cli.ts` imprime no
  stdout por padrão (pra dar pra redirecionar/`|`) ou escreve num arquivo
  com `--output`/`-o`, sem confirmação — mesmo padrão Unix de qualquer CLI
  com uma flag de saída explícita (`curl -o`, etc.), sem pedir confirmação
  porque o usuário já nomeou o destino explicitamente via flag.
- **Mascote (pinguim ASCII) segue a mesma separação pura-lógica/Ink-
  componente já estabelecida com `commands.ts`/`App.tsx`.** `src/tui/mascot.ts`
  é 100% dado/lógica pura (arte ASCII, seleção de frame por estado) — sem
  import de Ink/React, testável direto (`mascot.test.ts`). `src/tui/Mascot.tsx`
  são os componentes Ink que só consomem esses dados (`MascotBanner`,
  `MascotSpinner`) — sem lógica própria de seleção, por isso sem teste
  próprio (visual, não tem "estado" pra verificar além do que já está em
  `mascot.ts`). Arte só ASCII puro, sem Unicode largo/exótico, de propósito
  — o pedido foi não quebrar em terminal estreito, e ASCII simples também
  reduz risco de sair torto em terminais com suporte limitado a caracteres
  especiais.
  - Três lugares de uso: banner (`Banner` em `App.tsx`, dentro do `<Static>`
    — renderiza uma vez só, mesma abordagem do banner de texto já
    existente), spinner (`MascotSpinner` substitui `<Spinner type="dots" />`
    do `ink-spinner` quando o mascote está ligado, nos dois pontos onde
    o dots aparecia — tarefa única e "Rodando N tarefas em paralelo"), e
    reação (`mascotFaceFor("success"|"error"|"cancelled")`, prependida ao
    texto das entradas `"result"`/`"error"`/`"cancelled"` do transcript no
    momento em que são criadas, não num componente separado — evita
    precisar repassar `mascotEnabled` como prop até `TranscriptEntryView`).
  - **Deliberadamente sem carinha por tarefa no modo em lote (`;`)** — só o
    spinner/reação do modo de tarefa única e o resumo agregado
    "Rodando N tarefas em paralelo" ganham mascote; as caixas ao vivo por
    tarefa dentro de um lote (`LiveTask`) não. Decisão de escopo consciente
    (não uma limitação técnica): N pinguins piscando ao mesmo tempo lado a
    lado seria mais poluição visual que graça, e o pedido original não
    especificou isso pro modo em lote.
  - **`MascotSpinner` usa `setInterval` a cada 400ms** (mais lento que o
    dots padrão do `ink-spinner`, ~80ms, e mais rápido que o contador de
    segundos, 1000ms) — mesma categoria de atualização periódica que já
    existia antes (não introduz um padrão de risco novo pro bug de EIO,
    bug #3), mas validado de novo com PTY real mesmo assim, por rigor:
    tarefa real rodando com o mascote ligado, banner mostrando o pinguim,
    animação "pensando" aparecendo e ciclando por alguns segundos sob
    `incrementalRendering: true`, carinha feliz aparecendo no resultado —
    sem nenhum `EIO`/`uncaughtException` no log da sessão.
  - `ModeState.mascotEnabled` (`commands.ts`) segue o mesmo padrão de
    `forcedAgent`/`autoMode`/`routing`: campo independente, `/mascot`
    alterna (`toggle-mascot`, mesmo formato de `toggle-auto`), e
    `INITIAL_MODE_STATE.mascotEnabled` é sobrescrito pelo valor inicial que
    vem de fora (`App({ initialMascotEnabled })`) em vez de ser sempre
    `true` — é assim que a flag `--no-mascot` do CLI chega até o estado
    da TUI, sem precisar duplicar a lógica de toggle em dois lugares.
  - **`--no-mascot` é tratado ANTES do `commander` processar `argv`** — a
    TUI (zero subcomando) já era um caso especial resolvido por fora do
    `commander` (`if (argv.length === 0)`); `--no-mascot` só amplia essa
    checagem pra aceitar também `argv` com só essa flag e nada mais
    (`isTuiInvocation`). Não virou uma opção `commander` de verdade porque
    abrir a TUI não é um "comando" registrado nele, é o comportamento de
    fallback quando não há nenhum — registrar a flag lá exigiria também
    registrar um comando fantasma só pra ela existir.
- **`package.json` pronto pra `npm publish`, mas nunca publicado de
  verdade.** `files: ["dist"]` (não `.npmignore` — mais explícito, sem
  dois mecanismos de exclusão sobrepostos pra manter sincronizados) exclui
  `src/`, testes e config de build do pacote; validado com `npm pack
  --dry-run` (37 arquivos, só `dist/`, `LICENSE`, `README.md`,
  `package.json` — confirmado sem nada de `src/`). `prepublishOnly`
  (`npm test && npm run build`) impede publicar sem a suíte passando.
  `postbuild` já cuidava do bit de execução (bug #5); `files` cuida de não
  vazar código-fonte/testes no pacote publicado. **Ninguém deve rodar
  `npm publish` sem confirmação explícita** — isso é uma ação irreversível
  (não dá pra "despublicar" uma versão do jeito que dá pra reverter um
  commit).
- **`.orquestradorrc` (config por projeto) segue o mesmo molde de
  discovery do `CLAUDE.md` do Claude Code — implementado em `src/config.ts`,
  novo módulo no topo de `src/`, não dentro de `orchestrator/`/`tui/`
  porque é consumido por ambos (e pelo `cli.ts` direto).**
  - `discoverProjectConfig(startDir)`: começa em `startDir` (default
    `process.cwd()`), sobe um `dirname()` de cada vez até achar
    `.orquestradorrc` ou `dirname(dir) === dir` (raiz do FS). Pega o
    PRIMEIRO que encontrar — sem fusão de vários níveis (um
    `.orquestradorrc` de monorepo na raiz e outro numa subpasta não se
    combinam; o mais próximo do cwd simplesmente vence).
  - `parseOrquestradorConfig(raw)`: valida CADA campo individualmente
    (tipo E valor — `agent` precisa ser um `isAgentName()` de verdade,
    `routing` só "keyword"/"classify", `maxRetries`/`retryBaseDelayMs`
    inteiros positivos, `auto`/`mascot` booleanos) e descarta só o campo
    ruim, com um aviso específico — nunca invalida o arquivo inteiro por
    causa de UM campo errado, exceto quando o problema é estrutural (JSON
    inválido, ou o nível mais alto não é um objeto).
  - `resolveConfigValue(cliValue, projectValue)` = `cliValue ?? projectValue`
    — parece trivial de propósito: o "default global" de cada campo já
    está embutido mais embaixo (`options.routing ?? "keyword"` em
    `pipeline.ts`, `maxRetries = DEFAULT_MAX_RETRIES` em
    `agents/shared.ts`), então essa função só precisa decidir entre os
    dois primeiros níveis e deixar `undefined` passar adiante quando
    nenhum decidiu nada — não duplica uma tabela de defaults aqui.
  - `maxRetries`/`retryBaseDelayMs` **não têm flag de CLI própria hoje** —
    só `.orquestradorrc` ou o default global; por isso `resolveConfigValue`
    nem é chamado pra esses dois em `cli.ts`, é só `cfg?.maxRetries` direto.
  - Descoberta acontece **uma vez, no topo de `cli.ts`**, antes de
    qualquer `program.command(...)`, e vale pra TODOS os comandos
    (inclusive a TUI) — não é recalculada por comando. Avisos de campo
    inválido aparecem sempre, mesmo em `history`/`export` (comandos que
    nem usam `agent`/`routing`/etc.), porque um arquivo de config quebrado
    vale a pena avisar de qualquer jeito.
  - `retryBaseDelayMs` exigiu tornar o antigo `RETRY_BASE_DELAY_MS`
    (constante hardcoded em `agents/shared.ts`) em `AgentRunOptions`/
    `RunAgentCommandOptions.retryBaseDelayMs` (default
    `DEFAULT_RETRY_BASE_DELAY_MS = 1000`), repassado pela mesma cadeia já
    usada por `maxRetries` (wrappers → `pipeline.ts` → `agents/shared.ts`).
  - Na TUI, `agent`/`routing`/`auto` **seedam o `ModeState` inicial**
    (mesmo padrão de `--no-mascot` → `initialMascotEnabled`) — o usuário
    ainda pode trocar depois com `/agent`/`/routing`/`/auto` durante a
    sessão; o config só decide o PONTO DE PARTIDA, não trava a sessão
    inteira. `maxRetries`/`retryBaseDelayMs` são diferentes: viram props
    fixas (`App({ maxRetries, retryBaseDelayMs })`, repassadas direto pra
    todo `runPipeline`/`runPipelines` da sessão) — não fazem parte de
    `ModeState` porque não existe (nem foi pedido) um slash command pra
    mudar isso em runtime.
- **Histórico ganhou uma coluna `cwd` em `runs`** (não em `steps` — é uma
  propriedade da EXECUÇÃO, não de cada etapa) — `startRun()` grava
  `process.cwd()` no momento da chamada. `isWithinProjectScope(cwd,
  projectRoot)` (`storage/history.ts`) é a definição canônica, pura, de
  "esse run pertence a este projeto": `cwd === projectRoot` OU
  `cwd.startsWith(projectRoot + sep)`. **Filtragem acontece em JS, não via
  SQL `LIKE`** — decisão deliberada: um `LIKE` precisaria escapar `%`/`_`
  dentro de um path real (raro, mas um bug esperando pra acontecer) pra
  não bater em diretório errado; dado o volume de histórico esperado (uso
  local/pessoal, não um serviço multi-usuário), buscar todos os `runs`
  ordenados e filtrar+cortar em JS (`listRuns`) é mais simples e evita essa
  categoria inteira de bug, sem custo real de performance nessa escala.
  `listRuns`/`getLastRun` ganharam um segundo parâmetro opcional
  (`{ projectRoot }`) — omitido, comportamento de sempre (histórico
  global, sem filtro). `getRunById` (usado por `export`) **nunca** filtra
  por projeto — recebe um id explícito, não haveria o que "limitar".
  `cli.ts`'s `history` decide se filtra (`scopeToProject = !opts.all &&
  projectConfig !== undefined`) e imprime um aviso claro quando filtra,
  pra não parecer que o histórico "sumiu" silenciosamente.
- **A partir de agora, trabalho por branch + PR, nunca commit direto na
  `main`.** Toda mudança nova nasce numa branch (`feature/...`), e ao
  terminar abro PR via `gh pr create` pra revisão.
- **Nunca tire o script `postbuild` (`chmod +x dist/cli.js`) do
  `package.json`.** `tsc` não seta nem preserva o bit de execução nos
  arquivos que gera — sem esse script, `dist/` recriado do zero
  (`rm -rf dist && npm run build`, algo que já apareceu várias vezes só
  neste histórico de validação manual) quebra o binário linkado
  globalmente (`npm link`) com "permissão negada", mesmo o projeto
  continuando 100% funcional via `node dist/cli.js` — é um bug real que já
  aconteceu (bug #5), não uma precaução teórica.

## Adicionando um novo agente

Não tem um terceiro agente implementado hoje — isto é um guia de referência
pra quando (se) precisar, não uma feature em progresso. A arquitetura foi
generalizada (PR de roteamento/registro) especificamente pra que os passos
abaixo sejam a lista completa, sem precisar reabrir `pipeline.ts` nem
`router.ts` pra fiação nova.

**Passos obrigatórios** (o TypeScript te avisa se esquecer algum destes —
`Record<AgentName, ...>` em `agents/registry.ts` não compila com uma chave
faltando):

1. **`src/types.ts`** — adicione o nome na union `AgentName` (ex.:
   `export type AgentName = "claude" | "antigravity" | "novoagente";`).
   Único ponto de `types.ts` que precisa mudar.
2. **`src/agents/novoAgente.ts`** (novo arquivo) — implemente a interface
   `AgentRunner` (`(options: AgentRunOptions) => Promise<AgentRunResult>`,
   também em `types.ts`). Copie a forma de `claudeCode.ts`/`antigravity.ts`:
   monta `prompt` (concatenando `context` quando houver), monta
   `command`/`args` específicos do CLI novo, e delega tudo pra
   `runAgentCommand()` (`agents/shared.ts`) — que já cuida de timeout,
   classificação de erro (`AgentError`/`AgentErrorKind`) e retry com
   backoff. **Não reimplemente nada disso na mão** — se o novo CLI tiver
   uma peculiaridade de erro que os outros dois não têm (ex.: um jeito
   diferente de reportar "sessão expirada"), estenda as heurísticas de
   `shared.ts` (`looksLikeAuthError`/`looksLikeInvalidArgumentError`) em
   vez de duplicar a lógica de execução no wrapper novo.
3. **Meça se o CLI novo escreve stdout de forma incremental de verdade** —
   um probe manual tipo o que já foi feito pro claude/antigravity (`spawn`
   + log de timing dos chunks, ver "Estado atual" mais abaixo pro exemplo).
   **Nunca assuma** — é fácil supor que "todo CLI moderno deve streamar" e
   estar errado; a diferença real entre `claude -p` (não streama) e
   `agy -p` (streama) só foi descoberta medindo.
4. **`src/agents/registry.ts`** — adicione a entrada em `AGENT_REGISTRY`:
   `{ runner: runNovoAgente, streamsIncrementally: <resultado do passo 3> }`.
   Isso sozinho já propaga o agente novo pro roteamento por prefixo
   (`parseTaskAgentPrefix`), pra validação de `--agent`/`/agent`, e pro
   dispatch de verdade em `runPipeline()` — nenhum desses três precisa de
   edição.

**Passos que continuam manuais** (são julgamento de produto/UX, não
boilerplate — não dá pra derivar isso de lugar nenhum):

5. **`src/orchestrator/router.ts`** — se o agente novo deve participar do
   roteamento por palavra-chave (`planTask`), adicione uma lista de
   keywords (`NOVOAGENTE_KEYWORDS`) e estenda `buildPlan`/`planTask` pra
   considerá-la. Isso é uma decisão editorial genuína (que palavras
   disparam esse agente?), não uma lacuna de arquitetura — é totalmente
   válido um agente novo ficar de fora do roteamento por keyword e só ser
   alcançável via `--agent`/prefixo por tarefa/`--routing=classify`
   (`classifyTaskWithClaude` também precisaria ensinar o claude a
   considerar essa terceira opção na classificação, já que hoje o prompt
   de classificação só conhece "pesquisa"/"implementacao"/"ambos").
6. **`src/tui/App.tsx`** — adicione uma cor em `AGENT_COLORS` (o fallback
   `"white"` evita crash se você esquecer, mas o agente ficaria sem cor
   própria na tela, o que é ruim de usar mesmo não sendo um bug).
7. **Documentação** — `README.md` (tabela de roteamento por palavra-chave,
   se aplicável) e este arquivo (`CLAUDE.md`, este guia e "Estado atual").

**O que muda sozinho, sem tocar em nada**: validação de `--agent`/`/agent`
(via `isAgentName`), reconhecimento de `"novoagente:"` como prefixo válido
por tarefa (via `AGENT_NAMES`), e o dispatch de execução dentro de
`runPipeline()` (via `AGENT_REGISTRY`).

## Estado atual — MVP completo

- [x] Estrutura `.claude/` (settings.json, commands/, agents/, skills/)
- [x] `CLAUDE.md` na raiz + `README.md` (documentação voltada a uso)
- [x] `package.json` + estrutura de pastas `src/`
- [x] Wrappers de agente (`src/agents/claudeCode.ts`, `src/agents/antigravity.ts`,
      lógica de execução/erro compartilhada em `src/agents/shared.ts`)
- [x] Router (`src/orchestrator/router.ts`): `planTask()` por palavras-chave
      (split em 1 ou 2 etapas, pesquisa → implementação) e
      `classifyTaskWithClaude()` (classificação leve via IA pro `--auto`)
- [x] Pipeline (`src/orchestrator/pipeline.ts`) com **split de tarefa em
      etapas e handoff sequencial**: resolve o plano na ordem `--agent` →
      `planTask` → `--auto` → `resolveAmbiguousAgent` (prompt interativo ou
      erro); roda cada etapa passando o output da anterior como `context`.
- [x] Storage/histórico em SQLite (`src/storage/history.ts`), banco em
      `~/.orquestrador/history.db` — cada etapa grava `fed_by_step_id`
      apontando pro id da etapa anterior que alimentou seu contexto.
- [x] CLI entrypoint (`src/cli.ts`) com `run <tarefas...> [--agent] [--auto]`
      (uma tarefa = fluxo normal; várias = paralelo, ver abaixo) e
      `history [--last]` (mostra `#id` de cada etapa e qual a alimentou).
- [x] Fallback interativo pro roteamento ambíguo: `pipeline.ts` chama
      `resolveAmbiguousAgent` (injetado pelo `cli.ts`), que usa
      `node:readline/promises` pra perguntar `claude`/`antigravity`/`cancelar`
      no terminal. Cancelar lança `PipelineCancelledError` (tipo dedicado em
      `types.ts`), tratado no `cli.ts` com mensagem neutra (não como falha).
      Guarda contra stdin não-TTY (pipe/CI): não tenta interagir, cancela
      direto com mensagem indicando `--agent`.
- [x] Flag `--auto`: quando `planTask` retorna `[]` e `--agent` não foi
      passado, faz uma chamada isolada e leve ao `claude` (timeout de 30s)
      pedindo só a classificação "pesquisa"/"implementação"/"ambos"; usa o
      resultado pra montar o plano do mesmo jeito que `resolveAmbiguousAgent`
      faria. Se a chamada falhar ou a resposta vier inesperada, cai pro
      fallback interativo existente (ou erro, se também não for TTY).
      `--agent` sempre tem prioridade sobre `--auto`.
- [x] Paralelismo entre tarefas independentes: `runPipelines()`
      (`src/orchestrator/pipeline.ts`) roda `runPipeline()` uma vez por
      tarefa via `Promise.allSettled` (nunca `Promise.all` — uma tarefa
      falhando não pode derrubar as outras). `cli.ts` troca `run <tarefa>`
      por `run <tarefas...>` (variádico do commander); 1 tarefa = fluxo
      exatamente igual a antes (spinner, fallback interativo); 2+ tarefas =
      modo paralelo, sem spinner nem fallback interativo (imprime um
      cabeçalho `=== Tarefa i/N ===` por resultado conforme chegam).
      `printResult`/`printError` foram extraídas em `cli.ts` pra serem
      reaproveitadas pelos dois modos.
- [x] Testes automatizados com Vitest (171 casos):
  - `src/tui/mascot.test.ts` (8 testes) — `mascotThinkingFrame` cicla pelos
    4 frames na ordem certa e dá a volta (wrap-around) depois do último em
    vez de `undefined`/travar (inclusive depois de várias voltas
    completas); `mascotFaceFor` devolve uma carinha diferente pra cada
    estado (sucesso/erro/cancelado), as três distintas entre si, e do
    mesmo tamanho da carinha de "pensando" (mesmo personagem reagindo,
    não um desenho diferente); e a arte do banner tem altura/largura
    modestas (≤8 linhas, ≤20 colunas por linha) e é só ASCII puro
    (regex `^[\x00-\x7F]*$`), sem depender de renderizar nada.
  - `src/reporting.test.ts` — `buildMarkdownReport` com `HistoryRun`
    mockado (sem SQLite de verdade): título/metadados/contagem de etapas,
    heading de etapa com duração formatada e "alimentada pela etapa #N"
    quando há handoff, execução não finalizada mostrando isso
    explicitamente, etapa com erro mostrando `**Erro:**` em vez de
    `**Output:**`, tabela markdown de retries com `|` escapado na
    mensagem (e ausência da seção quando não há retries), usage só com
    tokens (sem custo, caso antigravity) não gerando linha de custo total,
    usage com custo (caso claude) aparecendo na etapa E no resumo do run,
    custo abaixo de 1 centavo usando mais casas decimais pra não
    arredondar pra US$ 0.00, custo parcial (só algumas etapas) avisando
    isso explicitamente em vez de fingir que é o total do run, e nenhuma
    etapa com usage não gerando seção nenhuma de tokens/custo.
  - `src/agents/claudeCode.test.ts` (5 testes, mockando `execa`) — chama o
    claude com `--output-format json`, extrai `.result` e o usage completo
    (tokens + custo real) do envelope, envelope sem usage/custo não quebra
    (campos undefined em vez de erro), stdout que não é JSON válido cai
    pro texto bruto sem lançar exceção, e JSON válido mas sem o campo
    `result` (formato inesperado) também cai pro texto bruto.
  - `src/agents/registry.test.ts` — `AGENT_REGISTRY` tem exatamente as
    entradas claude/antigravity, cada `runner` aponta pra mesma referência
    de função do wrapper de verdade (`toBe`, não só `toEqual`),
    `streamsIncrementally` reflete o probe manual documentado, `AGENT_NAMES`
    é derivado das chaves do registro, e `isAgentName` reconhece os dois
    agentes e rejeita nomes desconhecidos/variações de caixa.
  - `src/agents/shared.test.ts` (8 testes) — `runAgentCommand` (retry com
    backoff): sucesso depois de 1 retry (com o `onRetry` recebendo
    `attempt`/`maxRetries`/`delayMs` corretos), sequência completa de
    backoff 1s/2s/4s até o sucesso na 4ª tentativa, esgotamento de
    `maxRetries` propagando o `AgentError` final já com o array `retries`
    das tentativas anteriores embutido, comando não encontrado (ENOENT)
    falhando direto sem retry, e argumento inválido (heurística de stderr)
    classificado como `invalid_argument` e também falhando direto — usa
    `vi.useFakeTimers()`/`vi.runAllTimersAsync()` pra não esperar os delays
    de verdade. Mais 2 testes específicos pra confirmar que o backoff de
    uma chamada não atrasa uma chamada concorrente (a preocupação real por
    trás disso: `runPipelines()` roda várias tarefas via `Promise.
    allSettled`, cada uma com seu próprio `runAgentCommand`/retry
    independente — o `await sleep(delayMs)` do backoff é só um
    `setTimeout`, não pode travar o event loop nem atrasar as outras): um
    com `vi.useFakeTimers()` provando a não-bloqueância de forma
    determinística (avança 0ms com `advanceTimersByTimeAsync` — dreno de
    microtasks sem avançar o relógio — e confirma que a tarefa sem retry já
    resolveu enquanto a que está retentando ainda não, já que seu timer de
    1s não disparou), e outro com timers de verdade (`10_000`ms de timeout
    de teste, ~1s de duração real) medindo tempo de parede: a tarefa sem
    retry resolve em menos de 300ms mesmo com a outra presa no backoff de
    1s, e o tempo total do lote fica perto do delay de uma tarefa sozinha
    (~1s), não da soma das duas — confirma overlap real, não serialização.
    O 8º teste confirma que `retryBaseDelayMs` customizado (vindo de um
    `.orquestradorrc`, por exemplo) muda a base do backoff — `3000`/`6000`
    em vez do padrão `1000`/`2000` — sem mexer no multiplicador exponencial.
  - `src/orchestrator/router.test.ts` — `planTask` (4 combinações de
    palavra-chave + case insensitivity), `classifyTaskWithClaude` (3
    classificações possíveis, falha da chamada, resposta inesperada), tudo
    mockando `runClaudeCode`, e `parseTaskAgentPrefix` (5 testes): prefixo
    `claude:`/`antigravity:` reconhecido e removido do texto,
    case-insensitive e tolerando espaço antes do `:`, sem prefixo devolve o
    texto intacto, uma frase comum com `:` no meio (não logo após a
    primeira palavra) não é confundida com prefixo, e nome de agente
    desconhecido no formato de prefixo é sinalizado como inválido sem
    alterar o texto.
  - `src/orchestrator/pipeline.test.ts` — `--agent` forçado, split com
    handoff de contexto, tarefa ambígua com/sem resolvedor, cancelamento,
    falha de agente propagando erro e ainda logando/finalizando o run,
    `--agent` com prioridade sobre `--auto`, `--auto` classificando com
    sucesso e rodando o plano resultante, `--auto` caindo pro resolvedor
    quando a classificação falha ou vem inesperada, `runPipelines`
    (mapeamento tarefa → resultado, falha parcial isolada, tarefa ambígua
    no lote virando erro pontual, e uma checagem de concorrência real com
    margem de tolerância de `1.5x` o maior delay individual pra não ficar
    flaky), e streaming (`onStepStart`/`onStepComplete` disparando na
    ordem certa, chunks reais repassados sem passar pela simulação pro
    agente que streama de verdade, `simulateStreamingReveal` reconstruindo
    o texto original sem perda/duplicação pro agente que não streama —
    com `vi.useFakeTimers()` pra não esperar os ~500ms de verdade — e
    `onStepComplete` disparando pra uma etapa bem-sucedida mesmo se a
    etapa seguinte falhar depois), e `runPipelines` — streaming (3
    testes, também com `vi.useFakeTimers()`/`vi.runAllTimersAsync()`):
    `onTaskStepStart`/`onTaskChunk`/`onTaskStepComplete` chegando com o
    índice certo por tarefa; chunks de duas tarefas concorrentes (uma
    real via antigravity, outra simulada via claude) intercalados sem se
    misturar entre si (asserção por reconstrução do texto completo de
    cada tarefa, não por posição exata de chunk — que é detalhe de
    implementação da simulação); tarefa ambígua dentro do lote virando
    erro em vez de abrir prompt, mesmo com callbacks de streaming
    presentes; e `runPipeline`/`runPipelines` — retry (5 testes, agente
    mockado — o loop de retry em si já está coberto em `shared.test.ts`,
    aqui só a integração): `logStep` recebendo o array `retries` da etapa
    bem-sucedida e do erro final esgotado, `maxRetries`/`onRetry`
    repassados pro wrapper já com o agente amarrado quando disparado, erro
    não-elegível (`invalid_argument`) chegando com `retries: undefined`
    (o wrapper nem chegou a tentar de novo), e `onTaskRetry` do lote
    chegando com o índice certo da tarefa que precisou retentar; e prefixo
    de agente por tarefa (7 testes): `"claude: X"` força o agente e remove
    o prefixo do prompt enviado ao wrapper e do que vira `task`/histórico,
    sem prefixo continua caindo no roteamento normal por palavra-chave,
    `--agent` global tem prioridade sobre o prefixo por tarefa, prefixo com
    nome de agente inválido lança erro claro sem chamar nenhum agente nem
    abrir run, e no lote (`runPipelines`): cada tarefa pode forçar um
    agente diferente via seu próprio prefixo independente das outras
    (inclusive contrariando a keyword — ex. "antigravity: implementar X"),
    tarefa com prefixo inválido vira erro pontual sem afetar as demais, e
    `--agent` global sobrescreve o prefixo pro lote inteiro; e estratégia de
    roteamento (6 testes): padrão (`routing` omitido) continua chamando
    `planTask` primeiro sem nunca classificar, `routing: "classify"` pula
    `planTask` inteiramente mesmo numa tarefa com keyword óbvia (a
    classificação vira a primeira chamada, identificada pelo prompt conter
    "Classifique"), `routing: "classify"` ignora `--auto` (só 2 chamadas ao
    claude — classificação + etapa real —, nunca 3), `routing: "classify"`
    com a classificação falhando cai pro resolvedor de ambiguidade igual ao
    fluxo de keyword, `forceAgent` (global ou prefixo) tem prioridade sobre
    qualquer `routing`, e `runPipelines` repassa `routing` pra cada tarefa
    do lote (as duas classificam de verdade, mesmo a que tem keyword óbvia
    de antigravity — asserção por filtro de conteúdo do prompt, não por
    ordem de chamada, já que as duas tarefas rodam concorrentemente); e
    usage (2 testes): `result.usage` repassado pro `logStep` quando o
    agente expõe isso, e etapa sem usage (agente que não expõe)
    logando `usage: undefined` explicitamente, sem inventar nada.
  - `src/tui/commands.test.ts` — `parseInput` (task vs. cada slash command,
    case insensitivity, `/agent`/`/routing` com argumento inválido/ausente
    virando erro, `/mascot` virando `toggle-mascot` (sem argumento, é só um
    liga/desliga), comando desconhecido vira erro, `;`-separado com 2+
    partes não-vazias virando `{ kind: "tasks" }`, e `;` solto/sobrando no
    final caindo de volta pro `{ kind: "task" }` original) e
    `applyModeCommand` (`/agent` mudando `forcedAgent`, `/agent auto`
    resetando pra `null` mantendo o resto do estado, `/auto` alternando
    `autoMode` duas vezes, `/routing classify` mudando a estratégia mantendo
    o resto do estado, `/mascot` alternando `mascotEnabled`, comandos que
    não mexem no modo deixando o estado intacto, e os quatro campos sendo
    independentes entre si).
  - `src/tui/App.test.tsx` — renderiza `<App />` de verdade via
    `ink-testing-library` (stdin/stdout falso), mockando `runPipeline` e
    `listRuns`. Cobre: banner aparecendo uma única vez, fluxo completo de
    tarefa (spinner → resultado → input ativo de novo, incluindo digitar
    algo depois pra confirmar que o foco voltou), prompt de ambiguidade
    embutido (escolher agente e cancelar), os slash commands (`/agent`,
    `/auto`, `/agent auto`, `/history` com e sem execuções, comando
    desconhecido não quebrando a tela, `/exit` encerrando a aplicação)
    refletindo na `StatusLine` e no transcript, 3 testes de digitação em
    rajada **sem** o `tick()` de proteção usado nos outros testes (nenhum
    caractere perdido, Enter chegando logo em seguida ainda submete o
    texto completo, slash command reconhecido mesmo digitado rápido —
    ver bug #4 pra entender por que esses testes existem), 2 testes de
    streaming: a caixa ao vivo mostrando `[agente]` + o texto acumulado
    enquanto a etapa roda, e a tag `(simulando…)` aparecendo só quando o
    agente não streama de verdade, e (mockando também `runPipelines`) 3
    testes de múltiplas tarefas via `;`: duas tarefas rodando em paralelo
    com cada resultado aparecendo no bloco `Tarefa i/N` certo; streaming
    intercalado de duas fontes (uma real, outra simulada) aparecendo em
    caixas ao vivo separadas sem misturar texto de uma na outra — usa
    `lastIndexOf`/`indexOf` a partir dali pra isolar a seção de
    streaming ao vivo, já que o rótulo `Tarefa 1/2` também aparece antes,
    na entrada estática de anúncio da tarefa; e uma tarefa ambígua dentro
    do lote virando erro (nunca abre o prompt embutido, input volta pro
    placeholder normal em vez de ficar esperando resposta); mais 2 testes
    de prefixo de agente (`previewAgents()`): a prévia de rota (`→ agente`)
    de uma tarefa única respeitando o prefixo mesmo contrariando a
    keyword, e duas tarefas do mesmo lote com prefixos diferentes (mesma
    keyword nas duas) mostrando a prévia certa cada uma; mais 3 testes de
    `/routing`: muda a estratégia e reflete na `StatusLine` sem afetar
    `forcedAgent`/`autoMode` já setados, argumento inválido mostra erro
    amigável sem alterar o estado (continua em "keyword"), e uma tarefa
    rodada depois de `/routing classify` chega em `runPipeline` com
    `routing: "classify"` de verdade (não só na exibição); mais 7 testes
    de mascote: banner mostra o pinguim por padrão, `initialMascotEnabled={false}`
    (equivalente ao `--no-mascot`) tira o pinguim do banner e mostra
    "mascote: desligado" na `StatusLine`, `/mascot` alterna e reflete na
    `StatusLine`, o frame de "pensando" (`(o o)`) aparece no lugar do
    spinner padrão logo que uma tarefa começa a rodar, tarefa bem-sucedida
    mostra a carinha feliz (`(^ ^)`) junto do resultado, tarefa com erro
    mostra a carinha confusa (`(? ?)`) junto da mensagem, cancelamento
    mostra a carinha neutra (`(- -)`), e com o mascote desligado nenhuma
    carinha aparece em lugar nenhum (nem a de pensando, nem a de reação).
  - `src/config.test.ts` (18 testes) — `parseOrquestradorConfig` (config
    completo válido, objeto vazio, JSON inválido, JSON que não é objeto,
    cada campo validado e descartado independentemente com seu próprio
    aviso — incluindo o caso de borda `maxRetries: 0` sendo válido enquanto
    negativo/não-inteiro/string não são —, e múltiplos campos inválidos
    simultâneos gerando um aviso por campo, não um genérico único),
    `resolveConfigValue` (3 casos simples de precedência) e
    `discoverProjectConfig` usando diretórios temporários DE VERDADE
    (`mkdirSync`/`writeFileSync`/`rmSync` em `tmpdir()`, limpos no
    `afterEach`): achado no diretório de partida, sobe diretórios até achar
    o mais próximo (3 níveis aninhados), o mais próximo do cwd vence sobre
    um mais acima sem fazer merge dos dois, devolve `undefined` subindo até
    a raiz do FS quando não existe nenhum, e avisos de parsing propagando
    através da descoberta.
  - `src/storage/history.test.ts` (6 testes) — só a função pura
    `isWithinProjectScope`: bate exato na raiz do projeto, bate num
    descendente (inclusive vários níveis fundo), NÃO bate num diretório
    irmão com prefixo parecido (`/projeto-outro` não é descendente de
    `/projeto`), não bate num diretório pai nem num completamente não
    relacionado, e `cwd` ausente (runs de antes da coluna existir) nunca
    bate em nenhum projeto. Deliberadamente não cobre `listRuns`/
    `getLastRun` filtrando de verdade via SQLite de ponta a ponta — mesma
    lacuna de cobertura já documentada pra `storage/history.ts` em
    "Pendências conhecidas"; validado manualmente (ver "Testado
    manualmente" abaixo).
- [x] Tela interativa (`src/tui/App.tsx` + `src/tui/startTui.tsx`, Ink/React):
      `orquestrador` sem argumentos abre um transcript rolável tipo chat —
      digita tarefa, roda via `runPipeline()`, mostra spinner e resultado;
      `/history` (via `listRuns()`), `/exit`/`/quit`, `Ctrl+C` (padrão do
      Ink). Prompt de ambiguidade reimplementado em React (não usa
      `readline`, incompatível com o raw mode do Ink).
      Acabamento visual: banner de boas-vindas (dentro do `<Static>`, só
      renderiza uma vez), caixa com borda no input (muda de cor durante a
      execução), contador de segundos decorridos junto do spinner, prévia
      do roteamento logo abaixo da tarefa digitada (`→ antigravity` /
      `→ antigravity → claude`), e nomes de agente coloridos de forma
      consistente (`agentColor()`: antigravity=azul, claude=magenta) tanto
      na prévia de rota quanto no resultado.
- [x] Slash commands `/agent` e `/auto` na TUI (`src/tui/commands.ts`):
      `/agent claude|antigravity` seta `forcedAgent` (equivalente ao
      `--agent` do CLI, aplicado às próximas tarefas até trocar de novo);
      `/agent auto` reseta `forcedAgent` pra `null` (volta ao roteamento
      normal); `/auto` alterna `autoMode` (equivalente ao `--auto` do CLI).
      Os dois são independentes (`ModeState { forcedAgent, autoMode }`).
      Comando `/xxx` desconhecido, ou `/agent` com argumento inválido/
      ausente, retorna um erro amigável (`kind: "error"`) — nunca vira
      tarefa, nunca derruba a tela. Modo atual sempre visível numa
      `StatusLine` logo abaixo do transcript (`agente: automático` /
      `agente: claude (forçado)`, `auto: ligado`/`desligado`).
- [x] Streaming de output ao vivo na TUI. `streamsIncrementally` em
      `AGENT_REGISTRY` (`agents/registry.ts`) registra, por agente, se o
      CLI subjacente escreve stdout de forma incremental — confirmado com
      um probe manual (`node:child_process.spawn`
      + log de timestamp de cada chunk de stdout, ver arquivo de sessão
      descartável em `/tmp`, não versionado):
      - `agy -p`: **streaming real** — numa resposta longa, o stdout chegou
        em 5 a 9 chunks ao longo de 1 a 2 segundos, cadência de ~200ms.
      - `claude -p`: **sem streaming** — o stdout inteiro chegou num único
        chunk, só depois do processo já ter terminado de gerar a resposta
        completa internamente.
      `runAgentCommand` (`src/agents/shared.ts`) aceita `onChunk?: (chunk:
      string) => void`, ligado direto no stream real do `execa`
      (`subprocess.stdout.on("data", ...)`) — não inventa nada, só repassa
      o que realmente chega. `RunPipelineOptions` ganhou `onStepStart`,
      `onChunk(agent, chunk)` e `onStepComplete(result)`
      (`src/orchestrator/pipeline.ts`): pra um agente com streaming real, o
      `onChunk` do wrapper é repassado direto; pra um agente sem
      (`claude`), depois do resultado completo chegar,
      `simulateStreamingReveal()` revela o texto em ~24 pedaços ao longo de
      500ms fixos (não escala com o tamanho do texto, pra não *atrasar*
      artificialmente uma resposta longa) — **isso não é streaming de
      verdade**, é só um efeito visual, e o código deixa isso explícito
      (nome da função, comentário, e o `streamsIncrementally` do
      `AGENT_REGISTRY` controlando qual caminho roda). `onStepComplete` também faz cada
      etapa virar uma entrada do transcript assim que ela termina — não
      espera o plano inteiro (pesquisa → implementação) terminar pra
      mostrar o resultado da primeira etapa. `App.tsx` mostra um indicador
      "(simulando…)" ao lado do nome do agente quando o streaming daquela
      etapa é simulado, pra ficar claro pro usuário também, não só no
      código. `run`/`runPipelines` (modo não-interativo/paralelo) não
      passam nenhum desses callbacks — comportamento e performance
      inalterados ali.
- [x] Múltiplas tarefas concorrentes dentro da TUI. Sintaxe: separar as
      tarefas por `;` na mesma linha (`pesquisar X; implementar Y`) —
      escolhida em vez de um prefixo tipo `//` porque um prefixo ainda
      precisaria de um delimitador interno de qualquer forma, então só
      adicionaria um marcador sem eliminar a necessidade de um separador;
      `;` é mais simples, mais descobrível, e ecoa a convenção de
      encadeamento de comandos do shell. Parsing em
      `src/tui/commands.ts` (`parseInput`): faz `split(";")`, remove
      partes vazias/só espaço; 2+ partes não-vazias viram
      `{ kind: "tasks", texts }`, senão cai no comportamento de sempre
      (`{ kind: "task" }`), preservando a string original — um `;` solto
      ou sobrando no final não muda nada.
      Reaproveita `runPipelines()` (já existia, usado pelo `run` não-
      interativo) em vez de reimplementar execução paralela: ganhou
      `RunManyOptions.onTaskStepStart/onTaskChunk/onTaskStepComplete`
      (`src/orchestrator/pipeline.ts`), os mesmos três callbacks de
      streaming do `runPipeline`, só que com o índice (em `tasks`) da
      tarefa dona do evento — assim cada tarefa do lote tem seu próprio
      "canal" de streaming sem precisar de N chamadas separadas a
      `runPipeline`. **Sem `resolveAmbiguousAgent` em modo paralelo** —
      mesma regra que já valia pro `run "<tarefa1>" "<tarefa2>"` não-
      interativo: várias tarefas não podem disputar um único prompt de
      escolha de agente, então uma tarefa ambígua dentro do lote vira
      erro pontual daquela tarefa (mensagem "Não foi possível decidir...")
      em vez de abrir o prompt e travar as outras.
      `App.tsx`: `runTasksInParallel()` marca cada tarefa do lote com
      `batch: { index, total }`, adiciona uma entrada "task" no
      transcript por tarefa assim que o lote começa, e vai commitando
      resultado/erro por tarefa conforme `runPipelines` resolve cada uma
      (não espera o lote inteiro terminar pra mostrar a primeira). As
      caixas de streaming ao vivo (uma por tarefa, lado a lado no
      transcript enquanto rodam) usam **caracteres de texto puro**
      (`┌`/`│`) em vez de `Box`/`borderStyle` do Ink — decisão
      deliberada pra minimizar o volume de bytes por frame, dado o
      histórico do bug #3 (EIO) e que agora são múltiplos streams
      (reais e simulados) escrevendo na tela ao mesmo tempo.
- [x] Prefixo `agente:` por tarefa dentro de um lote. Sintaxe:
      `"claude: implementar X; antigravity: implementar Y"` — o `:` logo
      após o nome do agente (ver `parseTaskAgentPrefix` em Convenções pro
      regex exato e o trade-off assumido). Prioridade: `--agent`/`/agent`
      **global** (vale pro lote inteiro) > prefixo por tarefa >
      `planTask`/`--auto` de sempre. Implementado dentro de
      `runPipeline()` (não em `runPipelines()`), então funciona igual pra
      tarefa única, `run "<t1>" "<t2>"` e `;` da TUI sem duplicar lógica.
      `App.tsx` ganhou `previewAgents()` só pra prévia de rota (`→ agente`)
      mostrada antes do pipeline rodar de verdade, respeitando a mesma
      prioridade. Nome de agente inválido no prefixo (`"foo: X"`) joga um
      `Error` comum antes de `startRun()`/qualquer chamada de agente —
      dentro de um lote, vira só mais um resultado de erro pontual via
      `Promise.allSettled`, sem tratamento especial.
- [x] Estratégia de roteamento configurável (`--routing keyword|classify`,
      `/routing keyword|classify` na TUI). `"keyword"` é o padrão de sempre
      (`planTask` primeiro, `--auto` como fallback). `"classify"` promove
      `classifyTaskWithClaude()` de fallback-de-ambiguidade a estratégia
      PRIMÁRIA — toda tarefa é classificada via claude, mesmo uma com
      keyword óbvia, pulando `planTask()` inteiramente. `--auto`/`/auto`
      não tem efeito extra com `routing="classify"` (evita uma segunda
      chamada de classificação redundante). Implementado dentro de
      `runPipeline()`, mesma abordagem do prefixo por tarefa, então
      `RoutingStrategy` também é aceito em `RunManyOptions.routing` e
      repassado por `runPipelines()` pra cada tarefa do lote.
- [x] Arquitetura de agentes generalizada (`src/agents/registry.ts`) pra
      facilitar adicionar um terceiro agente sem tocar em `pipeline.ts`/
      `router.ts` — ver "Adicionando um novo agente" acima pro guia
      completo. `AGENT_REGISTRY` substitui as duas estruturas paralelas que
      existiam antes (`RUNNERS` hardcoded em `pipeline.ts` +
      `AGENT_STREAMS_INCREMENTALLY` em `types.ts`) por uma única fonte de
      verdade tipada (`Record<AgentName, AgentDefinition>` — o TypeScript
      recusa compilar se faltar uma entrada). `AGENT_NAMES`/`isAgentName()`
      derivados do registro substituem comparações hardcoded contra
      `"claude"`/`"antigravity"` em `cli.ts` (`--agent`), `commands.ts`
      (`/agent`) e `router.ts` (prefixo por tarefa) — as três aceitam um
      agente novo automaticamente assim que ele entra no registro, sem
      edição própria. `App.tsx`'s `agentColor()` virou um mapa com
      fallback neutro (`"white"`) em vez de um ternário de 2 ramos, pra
      degradar sem crash (mas não sem aviso visual) se um agente novo
      esquecer de ganhar cor própria.
- [x] `orquestrador export <runId>` — relatório em markdown de uma
      execução do histórico (`src/reporting.ts`, `buildMarkdownReport`),
      escrito no stdout por padrão ou num arquivo com `-o`/`--output`.
      `getRunById` (`storage/history.ts`) aceita id completo ou o prefixo
      de 8 caracteres já mostrado em `history`. Inclui uso de
      tokens/custo por etapa e o resumo de custo total do run quando
      disponível (ver bullet de usage acima).
- [x] Uso de tokens/custo (`AgentUsage`) — só pro claude, por decisão
      deliberada depois de medir o trade-off real com o streaming do
      antigravity (ver Convenções pro probe completo). `history --last`
      mostra tokens/custo por etapa e um resumo de custo total do run
      (marcado como parcial quando nem toda etapa reportou). Nunca
      inventamos um custo pro antigravity — só tokens, quando existirem.
- [x] Mascote (pinguim ASCII) na TUI (`src/tui/mascot.ts` + `Mascot.tsx`).
      Aparece no banner de boas-vindas (uma vez, dentro do `<Static>`),
      substitui o spinner padrão por uma animação "pensando" (`(o o)` →
      `(o o).` → `(o o)..` → `(o o)...`, ciclando a cada 400ms) enquanto
      uma tarefa roda, e reage no resultado: `(^ ^)` sucesso, `(? ?)` erro,
      `(- -)` cancelamento — mesma "família" visual (largura idêntica,
      só o par do meio muda). Liga por padrão; `orquestrador --no-mascot`
      desliga na abertura, `/mascot` alterna a qualquer momento dentro da
      tela. Sem carinha por tarefa no modo em lote (`;`) — decisão de
      escopo, ver Convenções. Arte só ASCII puro (sem Unicode largo), de
      propósito, pra não quebrar em terminal estreito.
- [x] `package.json` pronto pra `npm publish` (mas ainda **não publicado**
      de verdade): metadata completo (`name`, `version`, `description`,
      `bin`, `license`, `repository`/`bugs`/`homepage` apontando pro
      GitHub, `engines.node`, `keywords`, `author`), `files: ["dist"]`
      restringindo o pacote publicado a só `dist/` (mais `package.json`/
      `README.md`/`LICENSE`, incluídos sempre por padrão do npm) —
      confirmado com `npm pack --dry-run` que nem `src/` nem testes vazam
      no pacote. `prepublishOnly` (`npm test && npm run build`) barra
      qualquer `npm publish` acidental sem a suíte passando antes.
- [x] `.orquestradorrc` — config JSON opcional por projeto
      (`src/config.ts`), descoberto subindo diretórios a partir do cwd
      igual o `CLAUDE.md` do Claude Code (mais próximo do cwd vence, sem
      merge entre níveis). Configura `agent`/`routing`/`auto`/
      `maxRetries`/`retryBaseDelayMs`/`mascot`; cada campo validado
      independentemente (campo ruim vira aviso específico e é descartado,
      sem invalidar o arquivo inteiro). Precedência em `run`/TUI: flag de
      CLI > `.orquestradorrc` > default global embutido mais embaixo
      (`resolveConfigValue`, ver Convenções pro detalhe completo).
      `maxRetries`/`retryBaseDelayMs` não têm flag de CLI própria — só
      config ou default (decisão de escopo, ver Convenções).
- [x] Histórico filtrado por projeto. Nova coluna `runs.cwd` (migração
      pontual via `ensureColumn`, mesma técnica de `retries`/`usage`)
      grava `process.cwd()` em todo `startRun()`. `history` (CLI) mostra
      só as execuções do projeto atual quando existe um `.orquestradorrc`
      por perto (`isWithinProjectScope`, `storage/history.ts`), com
      `--all` pra ver o histórico completo de sempre. `export` **não** é
      afetado — o id já identifica uma execução específica sem ambiguidade.

Testado manualmente (chamando `agy`/`claude` reais do PATH, histórico de
teste sempre limpo depois):

- `run "pesquisar ... e implementar ..."` sem flags — split em 2 etapas,
  handoff confirmado (a resposta do claude referenciou o conteúdo gerado
  pelo antigravity), `history --last` mostrando `(alimentada pela etapa #1)`.
- `run "<tarefa ambígua>"` sem `--auto` e sem TTY — cancela limpo com
  `PipelineCancelledError`, sem travar (ver "bug encontrado" abaixo).
- `run "<tarefa ambígua>" --auto` — chamada real ao claude classificou
  corretamente, rodou só a etapa correspondente, e a chamada de
  classificação **não** apareceu no histórico.
- `history`, `history --last`, erro de roteamento ambíguo sem resolvedor,
  `--agent` inválido.
- `run "<tarefa1>" "<tarefa2>"` com duas tarefas reais roteadas pra agentes
  diferentes — tempo total ficou perto do maior delay individual (não da
  soma), confirmando overlap real entre os dois subprocessos; `history`
  mostrou duas entradas de `run` distintas com timestamps de início quase
  idênticos (~30ms de diferença).
- TUI (`orquestrador` sem args) testada de ponta a ponta com um PTY real
  via `pexpect` (Python), digitando caractere a caractere com delay pra
  simular digitação humana de verdade: `/history` vazio, tarefa ambígua →
  prompt embutido → escolher "cancelar" → mensagem de cancelamento, tarefa
  real (`pesquisar ...`) → spinner animando → resultado renderizado com
  `[agente] (Xms)` + output, `/exit` e `Ctrl+C` saindo limpo (raw mode
  desligado, sem lixo no terminal).
- Depois do acabamento visual + fix de `incrementalRendering`: tarefa real
  rodando de novo com sucesso (contador de segundos subindo até a
  conclusão, resultado renderizado corretamente), banner confirmado
  renderizando só uma vez (`grep -c` no log da sessão), e `/exit` saindo
  limpo (`exitstatus: 0`) esperando a tarefa terminar de verdade antes de
  digitar o próximo comando.
- Slash commands via PTY real: `/foobar` (comando desconhecido) mostrou
  erro amigável sem quebrar a tela; `/agent claude` forçou o agente e
  atualizou a `StatusLine`; `/agent` sozinho (sem argumento) mostrou a
  mensagem de uso sem alterar o estado; `/auto` ligou `autoMode` mantendo
  `forcedAgent` intacto (independência confirmada); `/agent auto` resetou
  `forcedAgent` mantendo `autoMode` ligado; e uma tarefa sem nenhuma
  palavra-chave (`"boa tarde, tudo bem?"`) rodou direto no `claude` sem
  abrir o prompt de ambiguidade, confirmando que `/agent claude` de fato
  bypassa `planTask`.
- Streaming, especificamente validado contra o risco de reintroduzir o bug
  #3 (EIO): tarefa real de resposta longa em cada agente, rodando rápido.
  `antigravity` (streaming real) — texto foi aparecendo aos poucos na
  caixa ao vivo, sem a tag `(simulando…)`, sem nenhum `uncaughtException`/
  `EIO` no log. `claude` (fallback simulado) — mesma coisa, com a tag
  `(simulando…)` aparecendo corretamente; os ~24 updates de estado em
  500ms (mais agressivo que qualquer digitação humana, de propósito, pra
  estressar o cenário que causou o bug #3) não estouraram o buffer do pty.
  Ambos terminaram e saíram limpo. Confirma que `incrementalRendering`
  (bug #3) segura mesmo sob a carga adicional do streaming.
- Múltiplas tarefas em paralelo na TUI, especificamente validado contra o
  risco de EIO com **múltiplos streams reais/simulados escrevendo na tela
  ao mesmo tempo** (o cenário que motivou esse cuidado extra): PTY real
  rodando um lote de 2 tarefas (`pesquisar ...; implementar ...`, uma
  antigravity com streaming real + uma claude simulada) e depois um lote
  de 3 (2 antigravity + 1 claude). Nos dois casos: os blocos ao vivo
  apareceram lado a lado, cada um com seu próprio rótulo `Tarefa i/N`,
  agente e (quando aplicável) tag `(simulando…)`; cada resultado foi
  commitado no transcript assim que a respectiva tarefa terminou, sem
  esperar as outras (`Tarefa 2/3 · [claude] (15310ms)` aparecendo antes
  das outras concluírem); **nenhum `EIO`/`uncaughtException` no log da
  sessão em nenhum dos dois lotes**; input voltou ao estado idle
  (`digite uma tarefa...`) depois que o lote inteiro terminou. Confirma
  que a mesma abordagem de renderização incremental que resolveu o bug
  #3 (`incrementalRendering: true`) segura também com N streams
  concorrentes, e que a escolha de caracteres de texto puro (em vez de
  `Box`/`borderStyle`) pras caixas ao vivo por tarefa não foi necessária
  além da margem de segurança já dada pelo `incrementalRendering`, mas
  manteve o volume de bytes por frame baixo por precaução.
- Retry automático: `run "pesquisar rapidamente o que é TCP"` de verdade
  (chamada real ao `agy`, sem forçar erro nenhum) continuou funcionando
  igual — nenhuma etapa passou pelo caminho de retry (`retries` não
  aparece em `history --last`), confirmando que a instrumentação nova não
  muda o caminho feliz. Migração da coluna `retries`: criado manualmente
  um `~/.orquestrador/history.db` com o schema **anterior** a essa mudança
  (sem a coluna), depois `history --last` (que aciona `getDb()`) leu os
  dados antigos normalmente e `PRAGMA table_info(steps)` confirmou a
  coluna `retries` adicionada em cima do banco existente, sem apagar nem
  recriar nada — valida que `ensureRetriesColumn` não quebra bancos de
  antes dessa mudança. O loop de retry em si (sucesso após N tentativas,
  esgotamento propagando erro, erro não-elegível falhando direto) foi
  validado via os testes automatizados de `shared.test.ts` (mockando
  `execa`) — não dá pra forçar `claude -p`/`agy -p` reais a falhar de
  forma transitória sob demanda pra um teste manual determinístico.
- Prefixo de agente por tarefa, com chamadas reais a `agy`/`claude`:
  `run "antigravity: implementar rapidamente, em texto só, um resumo de 1
  frase sobre recursão" "claude: pesquisar rapidamente, em texto só, uma
  frase sobre o que é HTTP"` — as duas tarefas têm keyword do agente
  OPOSTO ("implementar" rotearia pro claude, "pesquisar" pro antigravity
  por palavra-chave), e o prefixo inverteu isso em ambas: a primeira
  rodou de fato em `[antigravity]`, a segunda em `[claude]`.
  `history --last` confirmou que o prompt logado da segunda tarefa é só
  `"pesquisar rapidamente, em texto só, uma frase sobre o que é HTTP"` —
  sem o `"claude: "` na frente, confirmando que o prefixo é removido antes
  de virar prompt/histórico. Prefixo inválido dentro de um lote real:
  `run "foo: implementar algo" "claude: implementar..."` — a primeira
  tarefa falhou com `Prefixo de agente inválido: "foo:" em "foo:
  implementar algo". Use "claude:" ou "antigravity:" (ou nenhum
  prefixo).` e a segunda tarefa continuou rodando normalmente
  (`exitCode 1` do lote por causa só da primeira, sem derrubar a segunda),
  confirmando isolamento do erro por tarefa.
- Estratégia de roteamento, com chamadas reais: a mesma tarefa sem NENHUMA
  keyword (`"descreva rapidamente em uma frase o conceito de recursão"` —
  confirmado sem bater em nenhuma das listas de `router.ts`) teve
  comportamento diferente conforme a estratégia. Com o padrão
  (`--routing` omitido, sem `--auto`, stdin não-TTY): cancelou com "Não
  consegui identificar automaticamente... Entrada não é interativa" — o
  comportamento de sempre pra uma tarefa ambígua. Com `--routing=classify`:
  rodou de ponta a ponta sem erro nenhum, classificou como "ambos" e
  produziu as duas etapas (antigravity + claude). Confirma que `classify`
  resolve exatamente o caso que `keyword` não consegue, sem precisar de
  `--auto` nem de terminal interativo. `--routing=banana` (valor inválido)
  falhou direto com a mensagem de validação certa, sem chegar a rodar nada.
- Generalização do registro de agentes: com o registro em produção
  (`AGENT_REGISTRY`/`AGENT_NAMES`/`isAgentName` substituindo as estruturas
  antigas), rodei de novo `run "pesquisar rapidamente..."` real (sem
  `--routing`, sem prefixo) e confirmei que o comportamento — incluindo o
  streaming real do antigravity e o `(simulando…)` do claude, que dependem
  de `AGENT_REGISTRY[...].streamsIncrementally` — ficou idêntico a antes da
  refatoração. A suíte inteira (111 testes, incluindo todos os de streaming/
  retry/prefixo escritos antes dessa mudança) continuou passando sem
  nenhuma alteração nos próprios testes de streaming/retry — só o código de
  produção mudou de onde lê essas informações, não o comportamento.
- Uso de tokens/custo e `export`, de ponta a ponta com chamadas reais:
  `run "pesquisar... e implementar..."` rodou as duas etapas normalmente;
  `history --last` mostrou `tokens: entrada 2 · saída 105 · cache leitura
  16777 · cache criação 47517 · raciocínio 0 · custo US$ 0.19` na etapa do
  claude, **nenhuma linha de tokens/custo na etapa do antigravity**
  (confirmando que não inventamos nada pra ele), e `Custo total reportado:
  US$ 0.19 (1/2 etapas reportaram custo — parcial)` no resumo do run —
  exatamente o comportamento pretendido. `export <prefixo-de-8-chars>`
  gerou o markdown completo no stdout; `export <id> -o arquivo.md` salvou
  no arquivo certo (conteúdo idêntico ao stdout); `export <id-completo>`
  (UUID inteiro) funcionou igual ao prefixo; `export 00000000` (id
  inexistente) retornou `Nenhuma execução encontrada...` com exit code 1,
  sem crash. Migração da coluna `usage`: criado manualmente um
  `~/.orquestrador/history.db` com o schema anterior a essa mudança (já
  tinha `retries`, mas não `usage`), e `history --last` leu os dados
  antigos normalmente, com `PRAGMA table_info(steps)` confirmando a coluna
  `usage` adicionada em cima do banco existente sem apagar nada.
- Mascote, com PTY real (`pexpect`) e uma tarefa real (`agy`): banner
  mostrou o pinguim (`/o o\`) já no primeiro frame; depois de submeter a
  tarefa, o frame `(o o)` apareceu na primeira tentativa de Enter e a
  animação ciclou por alguns segundos sob carga real de streaming, sem
  nenhum `EIO`/`uncaughtException` no log da sessão; a carinha feliz
  `(^ ^)` apareceu junto do resultado ao terminar. Testado também
  `--no-mascot` (pinguim realmente ausente do banner, `StatusLine` já
  nasce em "mascote: desligado") e `/mascot` religando em runtime
  (confirmado com o padrão de retry de Enter já estabelecido neste
  projeto pra PTY — a primeira tentativa sem retry pareceu falhar, mas
  era só a flakiness de timing do pexpect já documentada aqui, não um bug:
  com retry, `/mascot` funcionou na primeira tentativa de verdade).
- `.orquestradorrc` + histórico por projeto, com o CLI real (`dist/cli.js`)
  rodando de dentro de um diretório temporário criado só pra esse teste:
  um `.orquestradorrc` com `{"agent": "claude", "routing": "classify"}`
  fez uma tarefa com keyword de pesquisa (que normalmente iria pro
  antigravity) rodar no claude mesmo assim (config vencendo `planTask`);
  `--agent antigravity` explícito na CLI venceu o config (precedência CLI
  > config confirmada); `history` de dentro desse diretório mostrou só as
  2 execuções feitas ali, escondendo uma 3ª execução feita de outro
  diretório sem config; `history --all` mostrou as 3; `history --last`
  devolveu a mais recente DAQUELE projeto, não a mais recente global.
  Um campo inválido (`"agent": "gpt-5"`) produziu o aviso esperado no
  stderr enquanto o `routing: "classify"` válido do mesmo arquivo
  continuou sendo aplicado. Migração da coluna `cwd`: mesmo procedimento
  já usado pra `usage` (banco criado manualmente sem a coluna) — dados
  antigos continuaram legíveis, com a coluna adicionada silenciosamente.
  TUI com PTY real: `.orquestradorrc` com `mascot: false` e
  `agent: "claude"` abriu a tela já com o pinguim ausente e
  `StatusLine` mostrando "agente: claude (forçado)" antes de qualquer
  interação do usuário — confirmando o seeding do `ModeState` inicial a
  partir do config.

Cinco bugs reais encontrados e corrigidos durante o desenvolvimento:

1. `rl.question()` sequencial do `node:readline/promises` trava
   indefinidamente quando o stdin é um pipe/não-TTY (a segunda chamada
   nunca resolve se o EOF chega perto da primeira — limitação conhecida do
   Node, não específica deste projeto). Não afeta uso interativo real
   (terminal nunca fecha o stdin), mas travaria silenciosamente em
   CI/scripts. Corrigido com uma guarda `process.stdin.isTTY` em
   `promptForAgent` (`src/cli.ts`).
2. A TUI (Ink) derrubava o processo com stack trace cru
   ("Raw mode is not supported...") se `orquestrador` (sem args) fosse
   invocado com stdin não-TTY. Mesma guarda `process.stdin.isTTY` aplicada
   antes de chamar `startTui()` em `cli.ts`, com mensagem amigável em vez
   de crash. Também: enquanto uma tarefa está rodando, o input da TUI
   precisa ficar desabilitado (`disabled` em `PromptInput`) — sem isso,
   teclas digitadas durante o spinner ficavam acumuladas no campo sem
   feedback e o Enter era descartado silenciosamente, exigindo apertar
   Enter de novo depois. Descoberto testando com PTY real.
3. Depois de adicionar acabamento visual (banner com borda, caixa de input
   com borda ocupando a largura toda do terminal), digitação rápida via
   PTY passou a travar o processo inteiro com `uncaughtException: Error:
   write EIO`. Causa raiz: sem renderização incremental, o Ink reescreve a
   árvore inteira a cada tecla; com caixas de borda largas, cada frame
   gera output grande o bastante pra estourar o buffer do pty quando várias
   teclas chegam em sequência rápida sem ninguém drenando a saída a tempo.
   Isolado comparando a versão pré-acabamento (que não reproduzia o mesmo
   travamento com a mesma técnica de teste) com a versão pós-acabamento, e
   confirmado via `process.on("uncaughtException")` temporário capturando
   o stack trace real. Corrigido passando `{ incrementalRendering: true }`
   pro `render()` em `startTui.tsx` — o Ink passa a atualizar só as linhas
   que mudaram, reduzindo bastante o volume de bytes por frame.
4. **`ink-text-input` perdia caractere em digitação rápida** — não uma
   suspeita, um bug real, confirmado em produção e não só em teste. A
   biblioteca computa o próximo valor do input a partir da prop `value`
   capturada no último render (`nextValue = originalValue.slice(...) +
   input + ...`) e só então chama `onChange(nextValue)` já pronto. Se duas
   teclas chegam em sequência rápida demais pro React re-renderizar entre
   uma e outra (rajada de digitação, ou múltiplos bytes chegando juntos no
   stdin), o segundo cálculo enxerga a prop desatualizada e descarta a
   primeira tecla — a análise inicial achava que era só um artefato de
   teste (daí um `tick()` de proteção entre caracteres no
   `App.test.tsx`), mas revisão apontou que isso mascarava o problema em
   vez de resolvê-lo. Reproduzido de forma determinística tanto com PTY
   real quanto com `ink-testing-library` escrevendo vários caracteres sem
   aguardar entre eles (`stdin.write()` corrido, sem `tick()`).
   **Corrigido substituindo `ink-text-input` por `src/tui/PromptInput.tsx`**
   (componente próprio): o valor "de verdade" mora numa `ref`, mutada de
   forma síncrona e imediata a cada tecla — nunca depende de uma prop ou
   closure de um render anterior; o `useState` usado pro display sempre lê
   o valor já atualizado da ref, nunca recalcula algo incrementalmente por
   conta própria. Validado: (a) três novos testes em `App.test.tsx`
   escrevendo em rajada **sem** o `tick()` de proteção, confirmando que a
   correção resolve de verdade (esses mesmos testes foram checados contra
   a implementação antiga via `ink-text-input` e falham lá, provando que
   não são triviais); (b) PTY real com digitação + backspace + tarefa real,
   confirmando que o texto final bate exatamente com o que foi digitado.
5. **`dist/cli.js` perdia o bit de execução (`chmod +x`) toda vez que
   `dist/` era recriado do zero** (`rm -rf dist && npm run build`) —
   `tsc` não preserva nem seta permissão de execução nos arquivos que
   gera, então o binário linkado globalmente (`npm link`, usado por quem
   desenvolve o projeto — `bin.orquestrador` aponta pra `./dist/cli.js`)
   passava a falhar com `permissão negada` ao rodar `orquestrador`
   direto (funcionava normal via `node dist/cli.js`, só o *shebang* direto
   quebrava). Descoberto quando o usuário reportou erro rodando
   `orquestrador` depois de uma sessão com vários `rm -rf dist && npm run
   build` de validação. Corrigido com um script `postbuild` em
   `package.json` (`chmod +x dist/cli.js`, roda automaticamente depois de
   `npm run build`, convenção nativa do npm de pre/post script) — não
   depende de lembrar de rodar `chmod` manualmente depois de build nenhum.

## Pendências conhecidas (pós-MVP)

- `planTask` e `classifyTaskWithClaude` avaliam a tarefa inteira; não fazem
  split textual real de uma frase em pedaços — cada etapa recebe o texto
  integral do prompt original, o handoff é só de *output* entre etapas.
- Sem sistema de migração de schema no SQLite de verdade — mudanças de
  schema em geral ainda exigem apagar `~/.orquestrador/history.db` em
  bancos antigos. `retries` e `usage` foram as exceções até agora: ganharam
  uma migração pontual e guardada (`ensureColumn(db, nomeDaColuna)` em
  `storage/history.ts`, generalizada a partir do `ensureRetriesColumn`
  original), não um mecanismo genérico de verdade tipo versionamento de
  schema — cada coluna nova ainda precisa de uma chamada extra explícita
  em `getDb()`.
- `agents/shared.ts` (`runAgentCommand`, incluindo o loop de retry) e
  `agents/claudeCode.ts` (parsing do envelope JSON/usage) têm teste
  automatizado agora; `agents/antigravity.ts` (só monta `command`/`args`)
  continua sem cobertura própria. O storage (`src/storage/history.ts`) tem
  cobertura **parcial**: só a função pura `isWithinProjectScope` é testada
  (`storage/history.test.ts`) — `listRuns`/`getLastRun` filtrando de
  verdade via SQLite, `startRun` gravando `cwd`, e `getRunById`, continuam
  validados só manualmente (ver "Testado manualmente").
- `promptForAgent` (`src/cli.ts`) não tem teste automatizado (readline
  interativo é difícil de testar sem TTY real); a lógica de decisão que ele
  alimenta (`resolveAmbiguousAgent` no pipeline) está coberta.
- O prefixo `agente:` por tarefa (`parseTaskAgentPrefix` em `router.ts`)
  reconhece qualquer token único seguido de `:` logo no início da tarefa —
  uma tarefa que legitimamente começa nesse formato sem ter nada a ver com
  escolha de agente (`"TODO: revisar X"`, `"obs: lembrar Y"`) vai virar
  erro de "agente inválido" em vez de rodar normal. Trade-off aceito
  conscientemente (ver Convenções), documentado no README também — não dá
  pra distinguir "tentativa de prefixo com erro de digitação" de "tarefa
  que só por acaso começa com uma palavra e dois pontos" sem mais contexto.
- Streaming: `simulateStreamingReveal` usa um tempo fixo (~500ms) e número
  fixo de pedaços (~24), independente do tamanho real do texto — não
  tentei calibrar isso com base em testes de usabilidade, só um valor que
  pareceu razoável. Se `claude -p` algum dia passar a suportar streaming
  de verdade em modo não-interativo, `AGENT_REGISTRY.claude.streamsIncrementally`
  (`agents/registry.ts`) é o único lugar que precisa mudar.
- `classifyTaskWithClaude` (`router.ts`) só sabe classificar em três
  categorias fixas — "pesquisa"/"implementacao"/"ambos", mapeadas
  hardcoded pra antigravity/claude/os-dois em `buildPlan`. Isso significa
  que `--routing=classify` **não generaliza sozinho** pra um terceiro
  agente: adicionar um novo agente ao `AGENT_REGISTRY` não ensina o prompt
  de classificação a considerá-lo — precisaria reescrever o prompt e
  `buildPlan` pra uma quarta categoria (ou um esquema diferente de
  classificação). Documentado também no passo 5 de "Adicionando um novo
  agente".
- `--auto`/`/auto` ligado junto com `--routing=classify`/`/routing
  classify` não avisa que a flag ficou sem efeito (silenciosamente
  ignorada, não é um erro) — só documentado em prosa (README/CLAUDE.md),
  não reforçado na UI.
- Uso de tokens/custo só é rastreado pro claude, por decisão deliberada
  (ver Convenções pro probe completo) — antigravity não tem `usage` nunca,
  pra preservar o streaming real dele. Além disso, a chamada de
  classificação do `--routing=classify`/`--auto`
  (`classifyTaskWithClaude`) também usa `runClaudeCode` por baixo, então
  também consome tokens/custo reais — mas como essa chamada nunca é logada
  como etapa (não é uma etapa do pipeline, ver Convenções), o usage dela é
  descartado silenciosamente, nunca aparece em `history --last` nem no
  `export`. Não é uma quantia gigante (é um prompt curto de classificação),
  mas é um custo real que hoje não fica visível em lugar nenhum.
- `history --last`/`export` só mostram custo **por run** — não existe uma
  visão agregada de custo total gasto ao longo do tempo (soma de todos os
  runs do histórico). Precisaria de uma nova consulta em
  `storage/history.ts` percorrendo todos os `runs`/`steps`.
- `--no-mascot` só funciona quando é a ÚNICA coisa em `argv` (junto de zero
  subcomando) — `orquestrador --no-mascot --alguma-outra-flag` não abriria
  a TUI (cairia no comportamento padrão do `commander`, que não reconhece
  nenhuma dessas flags soltas). Não é uma limitação real hoje porque não
  existe nenhuma outra flag pra combinar na abertura da TUI, mas se um dia
  aparecer uma segunda, `isTuiInvocation` em `cli.ts` precisa virar uma
  checagem de "é um subconjunto de flags conhecidas da TUI", não mais uma
  comparação de array de tamanho 1.
- Mascote: a arte é fixa (um só "personagem", sem opção de trocar
  cor/skin/expressões) — não foi pedido, e adicionar isso agora seria
  configuração especulativa sem uso real. Sem carinha por tarefa no modo
  em lote (`;`) — decisão de escopo consciente, ver Convenções, não uma
  limitação técnica.
- `.orquestradorrc`: só o arquivo mais próximo do cwd é considerado — um
  monorepo com config na raiz e outro numa subpasta não faz merge dos
  dois, o de baixo simplesmente vence por inteiro. `maxRetries`/
  `retryBaseDelayMs` não têm flag de CLI própria (decisão de escopo, ver
  Convenções) — hoje só dá pra configurar via arquivo. `export` é
  deliberadamente não filtrado por projeto. E o pacote **ainda não foi
  publicado no npm de verdade** — `package.json`/`npm pack --dry-run`
  validados, mas nenhum `npm publish` foi executado.
- Sem interface gráfica além da TUI de terminal, sem multi-tenant (fora de
  escopo do MVP).
