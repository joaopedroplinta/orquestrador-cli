# Perfis de agentes

Este diretório guarda instruções curtas, versionadas junto do projeto, para os
agentes que trabalham nele. O orquestrador pede a cada agente que leia
`.agents/team.md` e o perfil correspondente antes de alterar código.

Os arquivos seguem um contrato simples:

- `team.md` contém regras compartilhadas para trabalho paralelo.
- `claude.md`, `codex.md` e `antigravity.md` descrevem a responsabilidade
  esperada de cada ferramenta neste repositório.

Perfis não são configuração de credenciais, comandos de instalação ou uma fonte
de permissões. Mantenha-os curtos, específicos do projeto e revisáveis em pull
request. Para uma nova ferramenta, adicione seu perfil aqui e o adaptador dela
em `src/agents/`.
