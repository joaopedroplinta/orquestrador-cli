---
name: add-agent-wrapper
description: Padrão pra adicionar um novo agente de IA ao orquestrador (wrapper, entrada no router, testes). Use quando o usuário pedir pra integrar uma nova ferramenta de IA agentic além de Claude Code e Antigravity.
---

# Adicionar um novo agente de IA ao orquestrador

Checklist pra integrar um novo agente (ex: uma terceira ferramenta CLI
agentic) seguindo o mesmo padrão de `claudeCode.ts` e `antigravity.ts`.

## 1. Wrapper (`src/agents/<nomeDoAgente>.ts`)

- Função que recebe `(prompt: string, contextoDeHandoff?: string)` e retorna
  o output do agente + metadados (duração, timestamp, sucesso/erro).
- Dispara o comando via `execa` em modo não-interativo (flag de "print"
  equivalente a `-p`).
- Timeout configurável, default de 3–5 min.
- Erros tratados e convertidos num tipo específico (não deixar stack trace
  cru de `execa` vazar pro usuário):
  - timeout
  - comando não encontrado
  - sessão/autenticação expirada
  - exit code não-zero

## 2. Router (`src/orchestrator/router.ts`)

- Adicionar as palavras-chave ou critério que direcionam uma subtarefa pra
  esse novo agente.
- Se o critério por palavras-chave ficar ambíguo entre 3+ agentes, considerar
  se vale a pena evoluir pro "agente roteador" (fora de escopo do MVP, mas
  vale registrar como pendência no `CLAUDE.md`).

## 3. Pipeline (`src/orchestrator/pipeline.ts`)

- Confirmar que a sequência de execução e o handoff de contexto funcionam
  igual pros agentes existentes — não deve precisar de caso especial.

## 4. Storage (`src/storage/history.ts`)

- Nenhuma mudança de schema deveria ser necessária — o log já é genérico
  por agente (nome do agente é só mais um campo).

## 5. Testes

- Testar o wrapper isoladamente (mock do `execa`, casos de timeout/erro).
- Testar que o router escolhe o agente certo pras palavras-chave configuradas.

## 6. Atualizar documentação

- Seção "Estado atual" do `CLAUDE.md` da raiz.
