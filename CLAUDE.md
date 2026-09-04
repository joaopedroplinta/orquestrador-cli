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

1. Usuário roda `orquestrador run "tarefa aqui"`.
2. Roteamento decide o plano de etapas, nesta ordem de prioridade:
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
- **Output no terminal:** `chalk` (cores) + `ora` (spinners)
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
orquestrador history                     # lista execuções passadas
orquestrador history --last              # mostra detalhes da última execução
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
- Execução é **sequencial** no MVP — sem paralelismo entre agentes.
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
- [x] CLI entrypoint (`src/cli.ts`) com `run <tarefa> [--agent] [--auto]` e
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
- [x] Testes automatizados com Vitest (20 casos, `src/orchestrator/*.test.ts`):
  - `router.test.ts` — `planTask` (4 combinações de palavra-chave + case
    insensitivity) e `classifyTaskWithClaude` (3 classificações possíveis,
    falha da chamada, resposta inesperada), tudo mockando `runClaudeCode`.
  - `pipeline.test.ts` — `--agent` forçado, split com handoff de contexto,
    tarefa ambígua com/sem resolvedor, cancelamento, falha de agente
    propagando erro e ainda logando/finalizando o run, `--agent` com
    prioridade sobre `--auto`, `--auto` classificando com sucesso e rodando
    o plano resultante, `--auto` caindo pro resolvedor quando a
    classificação falha ou vem inesperada.

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

Bug real encontrado e corrigido durante o desenvolvimento: `rl.question()`
sequencial do `node:readline/promises` trava indefinidamente quando o stdin
é um pipe/não-TTY (a segunda chamada nunca resolve se o EOF chega perto da
primeira — limitação conhecida do Node, não específica deste projeto). Não
afeta uso interativo real (terminal nunca fecha o stdin), mas travaria
silenciosamente em CI/scripts. Corrigido com uma guarda `process.stdin.isTTY`
em `promptForAgent` (`src/cli.ts`).

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
- Execução sequencial, sem paralelismo entre agentes (fora de escopo do MVP).
- Sem interface gráfica, sem multi-tenant (fora de escopo do MVP).
