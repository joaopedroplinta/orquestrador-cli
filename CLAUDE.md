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
- **Tela interativa (`src/tui/`):** `ink` + `react` (`ink-spinner`, `ink-text-input`)
- **Testes:** `vitest`

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
  `ink-text-input`), chamando `runPipeline()` com um `resolveAmbiguousAgent`
  próprio; o resto (`agents/`, `router.ts`, `pipeline.ts`, `storage/`) é
  100% reaproveitado sem alteração.
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
  isso em conta.
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
- [x] Testes automatizados com Vitest (24 casos, `src/orchestrator/*.test.ts`):
  - `router.test.ts` — `planTask` (4 combinações de palavra-chave + case
    insensitivity) e `classifyTaskWithClaude` (3 classificações possíveis,
    falha da chamada, resposta inesperada), tudo mockando `runClaudeCode`.
  - `pipeline.test.ts` — `--agent` forçado, split com handoff de contexto,
    tarefa ambígua com/sem resolvedor, cancelamento, falha de agente
    propagando erro e ainda logando/finalizando o run, `--agent` com
    prioridade sobre `--auto`, `--auto` classificando com sucesso e rodando
    o plano resultante, `--auto` caindo pro resolvedor quando a
    classificação falha ou vem inesperada, e `runPipelines` (mapeamento
    tarefa → resultado, falha parcial isolada, tarefa ambígua no lote
    virando erro pontual, e uma checagem de concorrência real com margem
    de tolerância de `1.5x` o maior delay individual pra não ficar flaky).
- [x] Tela interativa (`src/tui/App.tsx` + `src/tui/startTui.tsx`, Ink/React):
      `orquestrador` sem argumentos abre um transcript rolável tipo chat —
      digita tarefa, roda via `runPipeline()`, mostra spinner e resultado;
      `/history` (via `listRuns()`), `/exit`/`/quit`, `Ctrl+C` (padrão do
      Ink). Prompt de ambiguidade reimplementado em React (não usa
      `readline`, incompatível com o raw mode do Ink). Sem testes
      automatizados (mesma decisão já tomada pra `promptForAgent`).
      Acabamento visual: banner de boas-vindas (dentro do `<Static>`, só
      renderiza uma vez), caixa com borda no input (muda de cor durante a
      execução), contador de segundos decorridos junto do spinner, prévia
      do roteamento logo abaixo da tarefa digitada (`→ antigravity` /
      `→ antigravity → claude`), e nomes de agente coloridos de forma
      consistente (`agentColor()`: antigravity=azul, claude=magenta) tanto
      na prévia de rota quanto no resultado.

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

Três bugs reais encontrados e corrigidos durante o desenvolvimento:

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
   precisa ficar com `focus={false}` (prop do `ink-text-input`) — sem isso,
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

## Pendências conhecidas (pós-MVP)

- `planTask` e `classifyTaskWithClaude` avaliam a tarefa inteira; não fazem
  split textual real de uma frase em pedaços — cada etapa recebe o texto
  integral do prompt original, o handoff é só de *output* entre etapas.
- Sem migração de schema no SQLite (mudanças de schema exigem apagar
  `~/.orquestrador/history.db` em bancos antigos).
- Sem testes automatizados pros wrappers de agente (`src/agents/*.ts`) nem
  pro storage (`src/storage/history.ts`) ainda — só router e pipeline têm
  cobertura.
- `promptForAgent` (`src/cli.ts`) não tem teste automatizado (readline
  interativo é difícil de testar sem TTY real); a lógica de decisão que ele
  alimenta (`resolveAmbiguousAgent` no pipeline) está coberta.
- Sem sintaxe pra forçar um agente diferente por tarefa individual no modo
  de várias tarefas — `--agent`/`--auto` valem pro lote inteiro.
- TUI: sem streaming de output ao vivo (decisão explícita — v1 mantém
  spinner-até-terminar, igual ao `run`); sem rodar tarefas em paralelo
  dentro da tela; sem `/agent`/`/auto` como comandos de barra.
- Sem interface gráfica além da TUI de terminal, sem multi-tenant (fora de
  escopo do MVP).
