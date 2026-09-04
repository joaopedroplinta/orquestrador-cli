---
description: Guia pra adicionar um wrapper de um novo agente de IA ao orquestrador
---

Guie a adição de um novo agente de IA agentic ao orquestrador (além de Claude
Code e Antigravity), seguindo o padrão dos wrappers existentes em `src/agents/`.

Passos a cobrir:

1. Criar `src/agents/<nomeDoAgente>.ts` seguindo a mesma interface dos
   wrappers existentes (`claudeCode.ts`, `antigravity.ts`): função que recebe
   um prompt (e contexto opcional de handoff), dispara o comando via `execa`
   com timeout, e retorna output + metadados de execução.
2. Tratar os mesmos casos de erro que os outros wrappers: timeout, comando
   não encontrado, sessão/autenticação expirada — nunca deixar o processo
   do CLI morrer com stack trace cru.
3. Registrar o novo agente no router (`src/orchestrator/router.ts`): adicionar
   as palavras-chave ou critério de roteamento que direcionam pra ele.
4. Verificar se o pipeline (`src/orchestrator/pipeline.ts`) precisa de algum
   ajuste pra lidar com o novo agente na sequência de handoff.
5. Adicionar/atualizar testes do wrapper novo.
6. Atualizar a seção "Estado atual" do `CLAUDE.md` da raiz.

Use a skill `add-agent-wrapper` (`.claude/skills/add-agent-wrapper/`) como
checklist detalhado do passo 1–2 antes de mexer no router.
