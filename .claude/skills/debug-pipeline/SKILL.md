---
name: debug-pipeline
description: Checklist pra investigar falha no handoff entre agentes no pipeline do orquestrador. Use quando uma execução `orquestrador run` falhar, travar, ou produzir um resultado incorreto/incompleto.
---

# Debugar falha no pipeline do orquestrador

Checklist pra investigar problemas na execução de `orquestrador run`.

## 1. Onde olhar os logs

- `orquestrador history --last` mostra prompts, outputs e tempo de cada
  etapa da última execução — comece por aqui.
- O histórico persistido em `src/storage/history.ts` (SQLite ou JSON,
  conforme implementado) tem o registro completo de cada passo: agente
  usado, prompt enviado, output recebido, timestamp, duração.

## 2. Isolar o passo que falhou

- Identifique qual agente (Claude Code ou Antigravity) estava rodando
  quando a falha ocorreu, olhando o campo de agente no log da etapa.
- Reproduza a chamada isolada, fora do orquestrador, rodando o comando
  shell equivalente direto no terminal:
  - `claude -p "<prompt exato do log>"`
  - `agy -p "<prompt exato do log>" --print-timeout 3m`
- Isso separa "o agente falhou" de "o wrapper/orquestrador tratou errado
  o resultado".

## 3. Causas comuns

- **Timeout**: prompt complexo demais pro timeout configurado (default
  3–5 min) — ver se o timeout do wrapper bateu antes do agente terminar.
- **Sessão expirada**: `claude` ou `agy` pedindo login de novo — lembrar
  que o orquestrador nunca lida com credenciais, então isso é problema de
  ambiente, não do código.
- **Handoff quebrado**: o output de uma etapa não virou corretamente parte
  do prompt da próxima — checar `pipeline.ts` na parte que monta o prompt
  seguinte a partir do resultado anterior.
- **Roteamento errado**: a subtarefa foi pro agente errado — checar as
  regras de palavras-chave em `router.ts` contra o prompt original do
  usuário.

## 4. Depois de corrigir

- Se a causa raiz for uma regra de roteamento mal calibrada ou um timeout
  baixo demais, considere se vale registrar como ajuste permanente (não só
  um fix pontual) e atualizar o `CLAUDE.md` se mudar algum comportamento
  documentado.
