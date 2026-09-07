# Orquestrador CLI

[![CI](https://github.com/joaopedroplinta/orquestrador-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/joaopedroplinta/orquestrador-cli/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/github/license/joaopedroplinta/orquestrador-cli)](LICENSE)

Uma CLI para coordenar **Claude Code**, **Codex** e **Antigravity** no mesmo
projeto. Ela escolhe ou recebe os agentes, preserva o contexto entre etapas e
oferece um modo de equipe com worktrees Git isoladas para mudanças paralelas.

## O que oferece

- Roteamento automático, escolha explícita e encadeamento entre agentes.
- Execução concorrente com limite configurável.
- TUI interativa com streaming, histórico, diagnóstico e controle de agentes.
- Equipes paralelas com plano DAG, dependências, worktrees e branch de integração.
- Caixa de mensagens, quadro de contratos e regras de posse de arquivos entre subtarefas.
- Estado persistido, recuperação de execuções interrompidas e limpeza segura de worktrees.
- Histórico local, relatórios em markdown e retry automático com backoff.
- Perfis versionados em [`.agents`](.agents/README.md) para orientar cada ferramenta.

## Requisitos

- Node.js 20 ou superior
- Git, para tarefas que alteram código e para o modo `team`
- Um ou mais CLIs já autenticados: `claude`, `codex` e `agy`

O orquestrador reutiliza a autenticação de cada CLI; ele não guarda ou gerencia
credenciais.

## Instalação

```bash
git clone https://github.com/joaopedroplinta/orquestrador-cli.git
cd orquestrador-cli
npm install
npm run build

# Valida Node, Git e os CLIs disponíveis.
node dist/cli.js doctor
```

O pacote ainda não foi publicado no npm. Depois da publicação, a instalação
global será `npm install -g orquestrador-cli`.

## Uso rápido

```bash
# Deixa a CLI escolher o agente pela tarefa.
node dist/cli.js run "pesquisar alternativas de autenticação"

# Escolhe um agente.
node dist/cli.js run "implementar testes de login" --agent codex

# Faz handoff sequencial entre especialistas.
node dist/cli.js run "antigravity>codex>claude: pesquisar, implementar e revisar login"

# Abre a interface interativa.
node dist/cli.js
```

Dentro da TUI, use `/help` para a lista de comandos. Exemplos úteis:

```text
/agent codex
/agents off antigravity
/team --agents claude,codex --concurrency 2 implementar login completo
```

`run` com várias tarefas executa no mesmo diretório. Para mudanças paralelas
em código, prefira `team run`, que isola os arquivos em worktrees.

`run` com várias tarefas roda todas em paralelo, sem prompt interativo (uma
tarefa ambígua vira erro pontual dela, sem travar as outras); dentro da TUI,
o mesmo efeito é separar as tarefas por `;` na mesma linha. Um prefixo por
tarefa (`claude: implementar X; antigravity: pesquisar Y`) força um agente
específico só para aquela tarefa do lote.

### Ligar e desligar agentes

Quando a cota de um agente acaba (ou o CLI dele não está instalado numa
máquina), dá para tirar ele de jogo sem trocar o roteamento na mão. O papel
dele (pesquisa ou implementação) é reatribuído ao próximo agente habilitado —
a tarefa não deixa de rodar, só muda quem executa.

```bash
orquestrador run --without antigravity "pesquisar a última versão do Node.js"
```

```text
/agents                    # lista os agentes e quem cumpre cada papel agora
/agents off antigravity    # tira ele de jogo pelo resto da sessão
/agents on antigravity     # devolve
```

`--without`, `/agents off` e `disabledAgents` (no `.orquestradorrc`, abaixo)
se somam — nenhum substitui o outro — e nenhum deles deixa a sessão sem
nenhum agente habilitado. Escolher explicitamente um agente desligado
(`--agent`, o prefixo `agente:`, a sequência `a>b:`) é erro, nunca
substituição silenciosa: o pedido era por aquele agente específico.

### Retry automático

Uma etapa que falha por um erro potencialmente transitório (timeout, sessão
expirada, exit code sem cara de erro de sintaxe) é retentada automaticamente
com backoff exponencial (1s, 2s, 4s...), até 3 vezes por padrão. Comando não
encontrado e argumento inválido falham direto — repetir não muda o
resultado. `orquestrador history --last` mostra quantas tentativas cada
etapa precisou.

## Equipes paralelas

O modo `team` recebe um objetivo, gera ou lê um plano e executa as subtarefas
em paralelo quando suas dependências permitem. Cada tarefa recebe uma worktree
e branch próprias. Ao final, os commits concluídos são reunidos em uma branch
de integração, sem tocar no checkout original.

```bash
# O planejador cria um DAG e os agentes executam até duas tarefas por vez.
node dist/cli.js team run "implementar login com backend, frontend e testes" \
  --agents claude,codex --planner claude --concurrency 2

# Para controle total, forneça o plano.
node dist/cli.js team run "implementar login" \
  --plan examples/team-plan.json --agents claude,codex --concurrency 2
```

O repositório precisa estar limpo e ter pelo menos um commit. Um plano pode
definir `dependsOn`, `owns` e `acceptance` para tornar dependências, áreas de
arquivo e critérios de conclusão explícitos:

```json
{
  "tasks": [
    {
      "id": "api",
      "agent": "codex",
      "task": "Implementar a API de sessão",
      "dependsOn": [],
      "owns": ["src/api/**"],
      "acceptance": "npm test passa"
    },
    {
      "id": "ui",
      "agent": "claude",
      "task": "Implementar o formulário de login",
      "dependsOn": ["api"],
      "owns": ["src/ui/**"],
      "acceptance": "npm test passa"
    }
  ]
}
```

Tarefas paralelas que declararem áreas sobrepostas são recusadas antes de
iniciar agentes. Use `team status <id> --follow` para acompanhar a execução e
`team send <id> <tarefa|all> "mensagem"` para enviar instruções.

### Depois de uma equipe

```bash
node dist/cli.js team list
node dist/cli.js team status <id> --messages

# Marca uma execução cujo processo morreu como encerrada, preservando arquivos.
node dist/cli.js team recover <id>

# Remove worktrees limpas; use as flags destrutivas somente após revisar o resultado.
node dist/cli.js team cleanup <id>
node dist/cli.js team cleanup <id> --force --delete-branches
```

Se um merge de dependência ou integração entrar em conflito, a worktree é
preservada para resolução manual. Use `git merge --abort` nela se decidir
descartar aquele merge pendente.

## Histórico e relatórios

```bash
orquestrador history                 # lista execuções passadas, mais recente primeiro
orquestrador history --last          # detalha a última: prompt, output, duração, tokens/custo
orquestrador export c97f3333         # relatório em markdown de uma execução (id completo ou prefixo de 8)
orquestrador export c97f3333 -o relatorio.md
```

Quando há um `.orquestradorrc` por perto, `history` mostra só as execuções
daquele projeto (`--all` ignora o filtro); `export` nunca é filtrado, já que
o id já identifica uma execução específica. **Custo é sempre parcial**:
Claude reporta tokens e custo real em USD; Codex reporta tokens sem custo;
Antigravity não reporta nada (troca-se isso por manter o streaming real dele
ao vivo). Um resumo que soma custo avisa quando nem toda etapa reportou.

## Configuração por projeto

Crie `.orquestradorrc` na raiz do projeto para definir preferências locais:

```json
{
  "agent": "claude",
  "routing": "keyword",
  "auto": false,
  "disabledAgents": ["antigravity"],
  "maxRetries": 5,
  "retryBaseDelayMs": 2000,
  "team": {
    "agents": ["claude", "codex"],
    "concurrency": 2,
    "timeoutMs": 300000,
    "bootstrap": ["npm", "ci"],
    "bootstrapTimeoutMs": 600000
  }
}
```

Todos os campos são opcionais. `bootstrap` é uma lista de programa e
argumentos, executada sem shell dentro de cada worktree antes da subtarefa —
útil para preparar dependências, mas pode aumentar tempo e uso de rede.
`maxRetries`/`retryBaseDelayMs` não têm flag de CLI própria — só dá para
configurar por aqui. Flags da CLI têm prioridade sobre as preferências
equivalentes do arquivo; `disabledAgents` e `--without` se somam (ver
"Ligar e desligar agentes" acima).

## Perfis de agentes

Use [`.agents`](.agents/README.md) para manter instruções específicas do
projeto em revisão de código. No modo `team`, o orquestrador pede que cada
agente leia `team.md` e seu perfil (`claude.md`, `codex.md` ou
`antigravity.md`) antes de trabalhar. Esses arquivos definem responsabilidades
e convenções; não guardam segredos nem concedem permissões.

## Arquitetura

| Área | Responsabilidade |
| --- | --- |
| `src/agents/` | Adaptadores para os CLIs externos e disponibilidade de agentes |
| `src/orchestrator/` | Roteamento, handoff e agendamento concorrente |
| `src/team/` | Planos, worktrees, contratos, orçamento e ciclo de vida das equipes |
| `src/tui/` | Interface Ink e comandos interativos |
| `src/storage/` | Histórico local de execuções |

## Desenvolvimento

```bash
npm run dev -- doctor
npm test
npm run build
```

As integrações externas são adaptadas atrás de interfaces testáveis; a suíte
não chama modelos reais. Alguns testes de equipe usam repositórios Git
temporários para validar worktrees e merges de verdade.

## Limitações atuais

- `doctor` confirma executáveis e Git, mas a autenticação só é conhecida ao
  chamar o respectivo agente.
- Custos são parciais: Claude reporta USD, Codex reporta tokens e Antigravity
  pode não reportar uso compatível.
- A entrega de mensagens entre agentes é cooperativa: o destinatário precisa
  consultar sua caixa de entrada.

## Licença

[MIT](LICENSE)
