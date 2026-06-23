# 10KK AIOPS

Central de operacoes AIOps com suporte a incidentes, agentes de IA, RAG, GLPI, Trello, Slack e Telegram.

## O que e

Plataforma completa que integra:

- **GLPI** (sistema de chamados) via container Docker
- **AIOps Middleware** com Node.js/Express + TypeScript
- **PostgreSQL** e **Qdrant** (banco vetorial para RAG)
- **Google Gemini** (analise de incidentes, embeddings e chat do Gerente AIOps)
- **Trello** (sincronizacao bidirecional com GLPI)
- **Grafana/Loki/Prometheus/Wazuh** (observabilidade)
- **Slack e Telegram** (notificacoes e chat operacional)
- **Runner Windows** (executa OpenCode e Claude Code localmente)
- **Relatorios PDF** de chamados por periodo, tecnico, status e tipo
- **Ferramentas de qualidade**: regressao visual, pentest/SAST/SCA e teste de carga

## Requisitos

| Ferramenta | Versao Minima | Onde obter |
|---|---|---|
| Docker Desktop | Ultima estavel | https://www.docker.com/products/docker-desktop/ |
| Node.js | 20+ | https://nodejs.org/ |
| OpenCode CLI (opcional) | Ultima | `npm install -g opencode-ai` |
| Claude Code CLI (opcional) | Ultima | https://docs.anthropic.com/en/docs/claude-code |

Gratuitos, mas obrigatorios:

- Chave de API do **Google Gemini** (https://aistudio.google.com/apikey)
- Token de API do **GLPI** (gerado dentro da interface do GLPI apos instalacao)

Opcionais conforme uso:

- Trello API Key + Token
- Slack Webhook / Bot Token / App Token
- Telegram Bot Token
- Grafana URL + Service Account Token

## Instalacao Automatizada (Recomendado)

Execute o script `setup.bat` na raiz do projeto:

```
setup.bat
```

O script executa automaticamente:

1. Verifica Docker e Node.js
2. Cria o `.env` a partir do `.env.example` (se nao existir)
3. Instala dependencias npm
4. Sobe todos os containers (GLPI, PostgreSQL, Qdrant, Middleware)
5. Aguarda healthchecks
6. Instala PM2 globalmente (se necessario)
7. Inicia o Runner no Windows com PM2
8. Exibe status final e URLs de acesso

**Atencao:** Na primeira execucao, o script pausa para que voce edite o arquivo `aiops-middleware\.env` com suas chaves. Pelo menos `GEMINI_API_KEY` e obrigatoria.

## Instalacao Manual (Passo a Passo)

### 1. Clone ou copie o repositorio

```powershell
git clone <url-do-repo> GPI-TRELLO
cd GPI-TRELLO
```

### 2. Configure o .env

```powershell
Copy-Item aiops-middleware\.env.example aiops-middleware\.env
```

Edite `aiops-middleware\.env` e preencha as variaveis obrigatorias:

```env
DATABASE_URL=postgresql://aiops:aiops_password@localhost:5432/aiops?schema=public

GLPI_API_URL=http://localhost:8080/api.php/v1
GLPI_WEB_URL=http://localhost:8080
GLPI_APP_TOKEN=seu_app_token
GLPI_USER_TOKEN=seu_user_token

GEMINI_API_KEY=sua_chave_gemini
GEMINI_MODEL=gemini-2.5-flash
MANAGER_MODEL=gemini-2.5-flash

CONFIG_ENCRYPTION_KEY=chave-longa-e-aleatoria-com-50-caracteres
RUNNER_TOKEN=outro-token-longo
```

### 3. Instale dependencias npm

```powershell
cd aiops-middleware
npm install
cd ..
```

### 4. Suba os containers

```powershell
docker compose up -d --build
```

Aguarde ate que todos os containers estejam saudaveis:

```powershell
docker compose ps
docker logs aiops_middleware --tail 50
```

### 5. Inicie o Runner Windows

O runner e o processo que executa os CLIs OpenCode e Claude Code diretamente no Windows:

```powershell
cd aiops-middleware

# Primeira execucao (teste)
npm run runner

# Para producao, use PM2:
pm2 start runner/server.mjs --name aiops-agent-runner --interpreter node
pm2 save
```

### 6. Acesse

| Servico | URL |
|---|---|
| Central de Comando | http://localhost:3333 |
| GLPI | http://localhost:8080 |
| Qdrant | http://localhost:6333 |
| Runner Health | http://localhost:3340/healthz |

### 7. Configure o GLPI (primeiro acesso)

1. Acesse http://localhost:8080
2. Faca o setup inicial (idioma, banco de dados: host=`glpi-db`, user=`glpi`, senha=`glpi_password`, db=`glpi`)
3. Apos login, va em **Administracao > API** e gere um **App Token**
4. Copie o token para `GLPI_APP_TOKEN` no `.env`
5. Gere um **User Token** para o usuario tecnico e copie para `GLPI_USER_TOKEN`
6. Reinicie o middleware: `docker compose restart middleware`

## Estrutura do Projeto

```
GPI-TRELLO/
├── docker-compose.yml        # Orquestracao unificada (GLPI + AIOps)
├── setup.bat                 # Script de instalacao automatizada
├── .gitignore                # Arquivoss ignorados pelo Git
├── README.md                 # Este arquivo
│
├── aiops-middleware/         # Middleware AIOps (Node.js/TypeScript)
│   ├── .env.example          # Template de variaveis de ambiente
│   ├── Dockerfile            # Build multi-stage do middleware
│   ├── package.json          # Dependencias e scripts
│   ├── tsconfig.json         # Configuracao TypeScript
│   ├── prisma/
│   │   ├── schema.prisma     # Modelo de dados (19 tabelas)
│   │   └── migrations/       # Migrations do banco
│   ├── src/                  # Codigo fonte TypeScript
│   │   ├── server.ts         # Entry point
│   │   ├── app.ts            # Fabrica do Express
│   │   ├── config/env.ts     # Validacao de variaveis de ambiente
│   │   ├── controllers/      # Handlers HTTP
│   │   ├── lib/              # Prisma client, logger
│   │   ├── repositories/     # Camada de dados
│   │   ├── routes/           # Rotas da API e Central
│   │   ├── schemas/          # Schemas Zod/validação
│   │   ├── services/         # 24 servicos de negocio
│   │   └── utils/            # Retry, helpers
│   ├── runner/
│   │   └── server.mjs        # Runner Windows (agentes CLI)
│   ├── public/               # Frontend da Central de Comando
│   └── storage/              # Volumes Docker (nao versionado)
│
└── glpi-local/               # GLPI containerizado
    ├── docker-compose.yml    # (obsoleto, usar o da raiz)
    └── storage/              # Volumes GLPI (nao versionado)
        ├── db/               # Dados MariaDB
        └── glpi/             # Arquivos e logs do GLPI
```

## Comandos Uteis

```powershell
# Subir/recriar tudo
docker compose up -d --build

# Ver status
docker compose ps
pm2 status

# Logs
docker logs aiops_middleware --tail 200
docker logs glpi_app --tail 100
pm2 logs aiops-agent-runner

# Reiniciar apenas o middleware
docker compose restart middleware

# Parar tudo
pm2 stop aiops-agent-runner
docker compose down

# Subir novamente (dados preservados nos volumes)
docker compose up -d
pm2 start aiops-agent-runner

# Atualizar schema do banco (apos alterar schema.prisma)
cd aiops-middleware
npm run prisma:generate
npm run prisma:migrate
docker compose restart middleware

# Verificar typescript
cd aiops-middleware
npm run typecheck
```

## Central de Comando

A Central Web em `http://localhost:3333` concentra a operacao diaria:

- **Visao geral**: filas de chamados novos, em andamento e pendentes, custos e execucoes recentes.
- **Gerente AIOps**: chat operacional via Web, Slack e Telegram com acesso a GLPI, logs, RAG e ferramentas.
- **Agentes**: cadastro de agentes OpenCode/Claude, teste oneshot, conta GLPI propria e execucao pelo runner Windows.
- **Relatorios**: filtros por periodo, tecnico, status, tipo e chamados sem tecnico, com exportacao em PDF.
- **Ferramentas**: regressao visual, pentest e stress/load test.
- **Configuracoes**: chaves, modelos, GLPI, Telegram, Slack, Grafana e telas externas.

### Relatorios

A tela de Relatorios consulta o GLPI e permite gerar uma previa e um PDF com:

- periodos diarios, semanais, mensais, anuais ou intervalo livre;
- filtro por criacao, atualizacao ou solucao;
- todos os tecnicos ou apenas tecnicos selecionados;
- chamados sem tecnico, status e tipos especificos;
- resumo executivo, distribuicoes, produtividade por tecnico e lista de chamados;
- opcao de incluir resumo, tarefas e acompanhamentos no PDF.

### Ferramentas de Qualidade

A aba Ferramentas possui:

| Ferramenta | Uso |
|---|---|
| Visual | Regressao visual com capturas por tela. |
| Pentest | Headers, CORS, TLS, webhook, rate limit, OWASP ZAP opcional, SAST e SCA. |
| Stress | Cenarios de carga com metricas de duracao e percentis. |

No Pentest, quando um projeto cadastrado contem varias aplicacoes, a UI detecta subprojetos e exibe um segundo dropdown. Isso evita varrer um megarepo inteiro quando a analise deve rodar somente em `Backoffice-Client`, `Backoffice-Server`, `OmniPay/api`, `Servidor-IA`, etc.

O runner valida que o subprojeto selecionado continua dentro de `PROJECTS_HOST_ROOT`; caminhos manuais como `..` ou absolutos sao rejeitados.

## Variaveis de Ambiente Essenciais

### Obrigatorias

| Variavel | Descricao |
|---|---|
| `GEMINI_API_KEY` | Chave da API Google Gemini |
| `GLPI_APP_TOKEN` | App Token gerado no GLPI |
| `GLPI_USER_TOKEN` | User Token do tecnico de integracao |
| `CONFIG_ENCRYPTION_KEY` | Chave para criptografar segredos (50+ caracteres) |
| `RUNNER_TOKEN` | Token compartilhado middleware <-> runner (32+ caracteres) |

### Aplicacao

| Variavel | Padrao | Descricao |
|---|---|---|
| `PORT` | `3333` | Porta do middleware |
| `LOG_LEVEL` | `info` | Nivel de log (trace/debug/info/warn/error) |
| `PROJECTS_HOST_ROOT` | `..` | Raiz de projetos acessivel pelo runner |
| `AGENT_POLL_INTERVAL_MS` | `15000` | Intervalo do monitor de agentes |
| `SYNC_INTERVAL_MS` | `30000` | Intervalo da sincronizacao GLPI/Trello |

### Integracoes (opcionais)

| Variavel | Descricao |
|---|---|
| `TRELLO_API_KEY` + `TRELLO_TOKEN` | Sincronizacao com Trello |
| `SLACK_WEBHOOK_URL` | Notificacoes de incidentes |
| `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` | Chat bidirecional via Socket Mode |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_CHAT_IDS` | Bot Telegram |
| `GRAFANA_URL` + `GRAFANA_SA_TOKEN` | Observabilidade (Loki/Prometheus/Wazuh) |

Veja `aiops-middleware\.env.example` para a lista completa com descricoes.

## Arquitetura

```
                          +------------------+
Grafana Alerting -------->|                  |------> GLPI
Grafana/Loki/Prom/Wazuh ->|                  |------> Trello
Slack / Telegram -------->| AIOps Middleware |------> Qdrant (RAG)
Central Web ------------->|     Docker       |------> Gemini (IA)
                           |                  |
                           +--------+---------+
                                    |
                                    | HTTP (host.docker.internal:3340)
                                    v
                           +------------------+
                           | Runner Windows   |
                           |                  |
                           | opencode run ... |
                           | claude -p ...    |
                           +------------------+
                                    |
                                    v
                           Pasta real do projeto
```

- O **middleware**, **PostgreSQL** e **Qdrant** rodam em containers Docker
- O **GLPI** e **MariaDB** tambem rodam em containers Docker (mesmo compose)
- O **runner** roda diretamente no Windows para reutilizar logins do OpenCode e Claude Code
- O middleware comunica-se com o GLPI via rede interna Docker (`http://glpi:80`)
- O middleware alcanca o runner via `host.docker.internal:3340`

## Servicos (AIOps Middleware)

| Servico | Responsabilidade |
|---|---|
| `incident.service` | Pipeline de alertas (firing/resolved) |
| `gemini.service` | Analise de causa raiz, RAG embeddings, Gerente |
| `glpi.service` | Cliente REST da API do GLPI |
| `trello.service` | Cliente REST da API do Trello |
| `sync.service` | Sincronizacao bidirecional GLPI/Trello |
| `manager.service` | Gerente AIOps (Web, Slack, Telegram) |
| `agent.service` | CRUD e configuracao de agentes |
| `agent-monitor.service` | Ciclo automatico de execucao dos agentes |
| `knowledge.service` | RAG - indexacao e busca vetorial no Qdrant |
| `loki-scanner.service` | Deteccao de erros em logs do Loki |
| `observability-scanner.service` | Scanner Prometheus/Wazuh |
| `grafana.service` | Descoberta de dashboards e datasources |
| `report.service` | Relatorios operacionais em PDF |
| `visual-test.service` | Regressao visual automatizada |
| `pentest.service` | Pentest, SAST, SCA, ZAP opcional e subprojetos |
| `loadtest.service` | Testes de carga/stress |
| `tool-run.service` | Historico, etapas, cancelamento e PDF das ferramentas |
| `slack-bot.service` | Bot Slack via Socket Mode |
| `telegram.service` | Bot Telegram com historico por chat |
| `approval.service` | Aprovacao humana de permissoes dos CLIs |
| `plan.service` | Planejamento colaborativo de chamados |
| `settings.service` | Configuracoes criptografadas (AES-256-GCM) |
| `usage.service` | Consumo de tokens e custo estimado |
| `audit.service` | Trilha de auditoria das acoes |
| `chat-account.service` | Vinculo de contas GLPI a canais de chat |
| `code.service` | Leitura de codigo fonte via runner |
| `slack.service` | Notificacoes de incidentes |
| `loki.service` | Cliente da API do Loki |

## Solucao de Problemas

### Docker nao inicia

```powershell
# Verifique se o Docker Desktop esta rodando
docker info

# Limpe e recrie os containers
docker compose down -v
docker compose up -d --build
```

### Middleware nao conecta ao banco

```powershell
# Verifique se o PostgreSQL esta saudavel
docker logs aiops_postgres --tail 20

# Acesse o banco manualmente
docker exec -it aiops_postgres psql -U aiops -d aiops
```

### Runner nao inicia

```powershell
# Verifique se a porta 3340 esta livre
netstat -ano | findstr :3340

# Execute o runner manualmente para ver erros
cd aiops-middleware
node runner/server.mjs
```

### GLPI nao carrega

```powershell
# O primeiro acesso demora alguns minutos (instalacao interna)
docker logs glpi_app --tail 50

# Aguarde e tente novamente
Start-Process http://localhost:8080
```

### PM2 nao reconhecido

```powershell
# Instale globalmente
npm install -g pm2

# Ou use o caminho completo
npx pm2 start runner/server.mjs --name aiops-agent-runner
```

### Portas em uso

```powershell
# Liste portas ocupadas
netstat -ano | findstr ":3333 :5432 :6333 :8080 :3340"

# Altere as portas no docker-compose.yml se necessario
```

## Seguranca

- Nunca versione o arquivo `.env` (esta no `.gitignore`)
- Use tokens dedicados com privilegio minimo
- Troque `CONFIG_ENCRYPTION_KEY` e `RUNNER_TOKEN` dos valores padrao
- Restrinja `PROJECTS_HOST_ROOT` a pasta que contem seus projetos
- O runner rejeita caminhos fora da raiz permitida
- O container do middleware roda com usuario `nodejs` (sem root)
- Apenas variaveis de API explicitamente permitidas sao encaminhadas aos CLIs
- Use HTTPS e autenticacao reversa (nginx) antes de expor a Central

## Limites e Observacoes

- A sincronizacao GLPI/Trello usa polling (nao webhooks)
- O webhook do Grafana nao possui autenticacao propria
- A Central Web nao possui autenticacao nativa
- O custo de tokens e uma estimativa local, confira na fatura do Google Cloud
- OpenCode e Claude Code precisam estar autenticados no Windows previamente
- Apenas caminhos dentro de `PROJECTS_HOST_ROOT` sao acessiveis pelo runner
