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
   `--agent` (força um agente, pula tudo) → `planTask` por palavras-chave →
   `--auto` (classificação leve via `claude`, só se o passo anterior veio
   vazio) → prompt interativo no terminal (só se os anteriores não
   resolveram) → erro/cancelamento.
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
orquestrador run "<tarefa>" --auto       # classifica via claude se ambígua
orquestrador run "<tarefa1>" "<tarefa2>" # roda várias tarefas independentes em paralelo
orquestrador history                     # lista execuções passadas
orquestrador history --last              # mostra detalhes da última execução
orquestrador                             # zero args: abre a tela interativa (Ink)
```

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
  `AGENT_STREAMS_INCREMENTALLY` (`types.ts`) registra isso por agente.
  `runAgentCommand` (`src/agents/shared.ts`) só liga um `onChunk` de
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
  ali e seria retentado à toa. Backoff exponencial simples: `1000 * 2^(tentativa-1)`
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
- **A partir de agora, trabalho por branch + PR, nunca commit direto na
  `main`.** Toda mudança nova nasce numa branch (`feature/...`), e ao
  terminar abro PR via `gh pr create` pra revisão.

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
- [x] Testes automatizados com Vitest (77 casos):
  - `src/agents/shared.test.ts` — `runAgentCommand` (retry com backoff):
    sucesso depois de 1 retry (com o `onRetry` recebendo `attempt`/
    `maxRetries`/`delayMs` corretos), sequência completa de backoff 1s/2s/4s
    até o sucesso na 4ª tentativa, esgotamento de `maxRetries` propagando o
    `AgentError` final já com o array `retries` das tentativas anteriores
    embutido, comando não encontrado (ENOENT) falhando direto sem retry, e
    argumento inválido (heurística de stderr) classificado como
    `invalid_argument` e também falhando direto — usa `vi.useFakeTimers()`/
    `vi.runAllTimersAsync()` pra não esperar os delays de verdade.
  - `src/orchestrator/router.test.ts` — `planTask` (4 combinações de
    palavra-chave + case insensitivity) e `classifyTaskWithClaude` (3
    classificações possíveis, falha da chamada, resposta inesperada), tudo
    mockando `runClaudeCode`.
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
    chegando com o índice certo da tarefa que precisou retentar.
  - `src/tui/commands.test.ts` — `parseInput` (task vs. cada slash command,
    case insensitivity, `/agent` com argumento inválido/ausente vira erro,
    comando desconhecido vira erro, `;`-separado com 2+ partes não-vazias
    virando `{ kind: "tasks" }`, e `;` solto/sobrando no final caindo de
    volta pro `{ kind: "task" }` original) e `applyModeCommand` (`/agent`
    mudando `forcedAgent`, `/agent auto` resetando pra `null` mantendo o
    resto do estado, `/auto` alternando `autoMode` duas vezes, comandos
    que não mexem no modo deixando o estado intacto, e os dois campos
    sendo independentes entre si).
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
    placeholder normal em vez de ficar esperando resposta).
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
- [x] Streaming de output ao vivo na TUI. `AGENT_STREAMS_INCREMENTALLY`
      (`types.ts`) registra, por agente, se o CLI subjacente escreve stdout
      de forma incremental — confirmado com um probe manual (`node:child_process.spawn`
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
      (nome da função, comentário, e a flag `AGENT_STREAMS_INCREMENTALLY`
      controlando qual caminho roda). `onStepComplete` também faz cada
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

Quatro bugs reais encontrados e corrigidos durante o desenvolvimento:

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

## Pendências conhecidas (pós-MVP)

- `planTask` e `classifyTaskWithClaude` avaliam a tarefa inteira; não fazem
  split textual real de uma frase em pedaços — cada etapa recebe o texto
  integral do prompt original, o handoff é só de *output* entre etapas.
- Sem sistema de migração de schema no SQLite de verdade — mudanças de
  schema em geral ainda exigem apagar `~/.orquestrador/history.db` em
  bancos antigos. A coluna `retries` foi a única exceção até agora: ganhou
  uma migração pontual e guardada (`ensureRetriesColumn` em
  `storage/history.ts`), não um mecanismo genérico reaproveitável pra
  futuras colunas.
- `agents/shared.ts` (`runAgentCommand`, incluindo o loop de retry) tem
  teste automatizado agora (`shared.test.ts`); os wrappers finos
  `claudeCode.ts`/`antigravity.ts` (só montam `command`/`args` e chamam
  `runAgentCommand`) e o storage (`src/storage/history.ts`) continuam sem
  cobertura própria.
- `promptForAgent` (`src/cli.ts`) não tem teste automatizado (readline
  interativo é difícil de testar sem TTY real); a lógica de decisão que ele
  alimenta (`resolveAmbiguousAgent` no pipeline) está coberta.
- Sem sintaxe pra forçar um agente diferente por tarefa individual no modo
  de várias tarefas — `--agent`/`--auto` (CLI) e `/agent`/`/auto` (TUI)
  valem pro lote inteiro, tanto no `run "<t1>" "<t2>"` quanto no `;` da
  TUI.
- Streaming: `simulateStreamingReveal` usa um tempo fixo (~500ms) e número
  fixo de pedaços (~24), independente do tamanho real do texto — não
  tentei calibrar isso com base em testes de usabilidade, só um valor que
  pareceu razoável. Se `claude -p` algum dia passar a suportar streaming
  de verdade em modo não-interativo, `AGENT_STREAMS_INCREMENTALLY.claude`
  é o único lugar que precisa mudar.
- Sem interface gráfica além da TUI de terminal, sem multi-tenant (fora de
  escopo do MVP).
