# AIOps Middleware

Central de comando para operação de incidentes, chamados e agentes de IA.

O projeto integra Grafana, Loki, Gemini, GLPI, Trello, Slack, Telegram, Qdrant e agentes locais executados pelos CLIs OpenCode e Claude Code no Windows.

## Principais recursos

- Recebimento de alertas do Grafana por webhook.
- Coleta de logs do Loki, métricas do Prometheus e eventos do Wazuh pelo Grafana.
- Análise de causa raiz com Google Gemini.
- Criação e atualização de chamados no GLPI.
- Sincronização bidirecional entre GLPI e Trello.
- Chat operacional com o Gerente AIOps na Web, Slack e Telegram.
- RAG dos chamados usando embeddings do Gemini e Qdrant.
- Ferramentas MCP e function calling para consultar e operar o ambiente.
- Planejamento colaborativo de lotes de chamados.
- Criação de agentes OpenCode e Claude Code.
- Execução dos agentes em pastas reais do Windows.
- Contas GLPI próprias para agentes automáticos.
- Contas GLPI vinculadas a conversas humanas.
- Aprovação humana para comandos bloqueados pelos CLIs.
- Registro de consumo de tokens, custos estimados e auditoria.
- Relatórios operacionais customizáveis com exportação em PDF.
- Telas externas configuráveis na barra lateral.

## Arquitetura

```text
                         +------------------+
Grafana Alerting ------> |                  | ------> GLPI
Grafana/Loki/Prom/Wazuh>|                  | ------> Trello
Slack / Telegram ------> | AIOps Middleware | ------> Qdrant
Central Web -----------> |     Docker       | ------> Gemini
                         |                  |
                         +--------+---------+
                                  |
                                  | HTTP host.docker.internal:3340
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

O middleware, PostgreSQL e Qdrant rodam em Docker. O runner roda diretamente no Windows para reutilizar os logins locais já existentes do OpenCode e Claude Code.

## Componentes

| Componente | Função |
|---|---|
| Middleware | API, Central Web, Gerente, bots, sincronização e orquestração. |
| PostgreSQL | Incidentes, agentes, execuções, configurações, chats, planos e auditoria. |
| Qdrant | Vetores do RAG dos chamados GLPI. |
| Runner Windows | Executa os CLIs e acessa as pastas reais dos projetos. |
| GLPI | Fonte operacional de chamados, tarefas, comentários e responsáveis. |
| Trello | Representação visual e sincronizada dos chamados. |
| Gemini | Gerente, análise de incidentes e embeddings. |

## Requisitos

- Docker Desktop com Docker Compose.
- Node.js 20 ou superior no Windows.
- GLPI acessível pela API REST.
- Chave da API Gemini.
- OpenCode e/ou Claude Code instalados e autenticados no Windows.
- Trello, Slack, Telegram e Grafana são opcionais conforme o uso.

## Início rápido

### 1. Configuração

Crie o arquivo `.env` a partir do exemplo:

```powershell
Copy-Item .env.example .env
```

Preencha pelo menos:

```env
DATABASE_URL=postgresql://aiops:aiops_password@localhost:5432/aiops?schema=public

GLPI_API_URL=http://localhost:8080/api.php/v1
GLPI_APP_TOKEN=
GLPI_USER_TOKEN=

GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
MANAGER_MODEL=gemini-2.5-flash

CONFIG_ENCRYPTION_KEY=use-uma-chave-longa-e-aleatoria
RUNNER_TOKEN=use-outro-token-longo
PROJECTS_HOST_ROOT=C:\Projetos
```

No Docker Compose, `DATABASE_URL`, `GLPI_API_URL` e `RUNNER_URL` são sobrescritos para os endereços internos adequados.

### 2. Runner no Windows

Instale as dependências:

```powershell
npm install
```

Inicie o runner:

```powershell
npm run runner
```

O runner escuta por padrão em:

```text
http://localhost:3340
```

Para mantê-lo em segundo plano:

```powershell
pm2 start runner/server.mjs --name aiops-agent-runner --interpreter node
pm2 save
```

O runner deve permanecer no Windows. Não é necessário autenticar OpenCode ou Claude dentro do Docker.

### 3. Docker

Suba o middleware:

```powershell
docker compose up -d --build
```

O container aplica automaticamente as migrations do Prisma antes de iniciar.

### 4. Acessos

```text
Central de Comando: http://localhost:3333
Health:             http://localhost:3333/healthz
Readiness:          http://localhost:3333/readyz
Qdrant:             http://localhost:6333
Runner Windows:     http://localhost:3340/healthz
```

## Central de Comando

A interface Web possui:

- Visão geral de custos e filas do GLPI: novos, em andamento e pendentes.
- Chamados ordenados do mais antigo para o mais novo, com tempo aberto, status e técnico.
- Gerente AIOps com conversas separadas por canal.
- Cadastro, teste e acompanhamento dos agentes.
- Consumo de tokens e custo estimado.
- Relatórios diários, semanais, mensais, anuais ou por intervalo personalizado.
- Ferramentas de qualidade: regressão visual, pentest/SAST/SCA e stress/load test.
- Histórico de execuções com detalhe clicável e console do CLI atualizado em tempo real.
- Configurações e credenciais.
- Telas personalizadas para GLPI, Grafana, Trello ou outros sites.

### Ambientes do Backoffice Omni-Inbox

O Gerente diferencia o produto Backoffice das ferramentas operacionais da Central:

| Ambiente | Endereço |
|---|---|
| Desenvolvimento | `https://backoffice.omni-inbox.com` |
| Homologação | `https://backoffice.omni-inbox.com.br` |
| Produção | `https://backoffice.omni-inbox.ai` |

### Configurações

As configurações podem ser alteradas pela própria interface. Segredos são criptografados com AES-256-GCM antes de serem armazenados no PostgreSQL.

O campo `MANAGER_MODEL` é um dropdown preenchido dinamicamente com os modelos disponíveis para a `GEMINI_API_KEY` que suportam geração de conteúdo. O modelo selecionado é global para o Gerente na Web, Slack e Telegram.

## Gerente AIOps

O Gerente conversa em português e combina:

- Histórico independente por sessão.
- Contexto operacional dos chamados.
- RAG no Qdrant.
- Function calling nativo do Gemini.
- Ferramentas para GLPI, agentes, logs, código, planos e aprovações.

Os canais são separados:

```text
web
telegram:<chatId>
slack:<channelId>
```

A Central Web permite abrir qualquer uma dessas conversas e responder diretamente no canal de origem.

### Capacidades

- Listar e consultar chamados abertos ou fechados.
- Adicionar comentários.
- Consultar responsáveis e conteúdo completo.
- Atribuir chamados a agentes automáticos.
- Atribuir chamados a usuários humanos do GLPI.
- Entender “coloque o chamado no meu nome” usando a conta vinculada ao canal.
- Listar contas ativas do GLPI.
- Consultar os chamados atribuídos a qualquer técnico pelo nome ou username GLPI.
- Gerar uma estimativa gerencial de progresso baseada em status, tarefas, acompanhamentos e execuções.
- Enviar cobranças, lembretes e avisos diretamente aos canais vinculados de um técnico.
- Criar várias tarefas GLPI, pendentes ou concluídas, em uma única solicitação.
- Converter listas numeradas ou listas simples enviadas pelo chat em tarefas GLPI, preservando os detalhes de cada item.
- Entender “atividades” como tarefas GLPI e usar o chamado ativo/recente da conversa quando o usuário não repetir o número.
- Comentar e solucionar vários chamados em uma única ordem administrativa.
- Delegar uma instrução a um agente, registrando-a no chamado antes da execução.
- Consultar logs reais no Loki, métricas Prometheus e eventos Wazuh/OpenSearch.
- Pesquisar na internet (Google) com citação das fontes: preços, planos de fornecedores, documentação e comparativos.
- Ler estrutura e arquivos dos projetos autorizados.
- Pesquisar texto no código.
- Consultar execuções e erros dos agentes.
- Aprovar ou negar permissões pendentes.
- Criar planos de chamados e gravá-los após confirmação.
- Anexar arquivos e solucionar chamados permitidos pelo chat.

### Planejamento de chamados

O Gerente pode construir, junto com o usuário, uma sequência de requisições:

1. Entende o objetivo.
2. Faz perguntas de escopo.
3. Verifica chamados existentes para evitar duplicação.
4. Propõe itens com ordem, descrição, critérios de aceite, prioridade e dependências.
5. Salva o plano como rascunho.
6. Permite revisões durante a conversa.
7. Cria os chamados no GLPI somente após confirmação explícita.

Os planos ficam persistidos como `DRAFT`, `CONFIRMED` ou `CANCELLED`.

## RAG e Qdrant

O RAG usa:

```text
Modelo de embedding: gemini-embedding-001
Collection:           glpi_tickets
Distância:            Cosine
```

O botão `Reindexar RAG` busca os chamados recentes do GLPI, monta o contexto completo e atualiza seus vetores no Qdrant.

Quando `GEMINI_BATCH_EMBEDDINGS_ENABLED` está ativo (padrão), o reindex gera os embeddings pela Batch API do Gemini, com 50% de desconto. Se o lote não concluir em até 10 minutos ou a Batch API estiver indisponível, o reindex cai automaticamente para o fluxo inline.

Se o Qdrant estiver indisponível, a busca possui fallback textual limitado aos chamados recentes.

## MCP

O servidor MCP usa JSON-RPC por HTTP:

```text
POST /api/mcp
```

Métodos suportados:

- `initialize`
- `tools/list`
- `tools/call`

Ferramentas básicas MCP:

- `tickets_list`
- `ticket_get`
- `ticket_comment`
- `ticket_assign_agent`
- `telegram_send`

O chat do Gerente possui ferramentas nativas adicionais para RAG, planejamento, logs, código, usuários GLPI, anexos, solução, aprovações e execuções.

## Contas GLPI por conversa

Cada conversa do Slack ou Telegram pode ser associada a uma conta GLPI.

No botão `Configurar conta GLPI`, é possível:

- Selecionar uma conta ativa diretamente da lista do GLPI.
- Criar uma nova conta escolhendo username e nome.

A mesma pessoa pode vincular sua conta GLPI ao Slack e ao Telegram. Quando um chamado for atribuído a essa conta, todos os canais vinculados recebem o aviso.

### Operação pelo chat

Depois da atribuição:

- Uma mensagem de andamento vira acompanhamento no GLPI.
- Imagens, PDFs e documentos viram anexos.
- “Pode finalizar” registra a solução e soluciona o chamado.
- “Quais são meus chamados?” lista os chamados ativos daquela pessoa.
- “Coloque o chamado #42 no meu nome” atribui o chamado à conta vinculada.
- “Envie uma cobrança para Carla sobre o chamado #42” entrega a mensagem no Slack e/ou Telegram vinculado à conta dela.
- “Comente a causa em todos esses chamados e finalize-os” aplica a ação aos chamados enumerados imediatamente antes, sem exigir atribuição prévia.
- A resposta da pessoa é encaminhada automaticamente para a conversa que originou a solicitação.
- Após 24 horas sem acompanhamento, o Gerente solicita uma atualização.

### Estimativa gerencial

Ao consultar o trabalho de um técnico, o Gerente apresenta cada chamado com:

- resumo do objetivo ou problema;
- atividade atual;
- percentual estimado;
- confiança da estimativa;
- evidências consideradas;
- próximo passo sugerido.

O percentual não é um campo oficial do GLPI. Ele é calculado a partir do status do chamado, proporção de tarefas concluídas, acompanhamentos e última execução de agente. A estimativa é arredondada e deve ser usada como apoio gerencial, não como medição contratual.

Uma conversa só pode comentar, anexar ou solucionar chamados que continuam atribuídos à sua conta GLPI.

## Agentes locais

Cada agente possui:

- Nome e descrição.
- CLI: `OPENCODE` ou `CLAUDE`.
- Perfil de operação.
- Pasta Windows do projeto.
- Modelo opcional.
- Instruções personalizadas.
- Estado ativo ou pausado.
- Conta GLPI própria.

Perfis disponíveis:

| Perfil | Comportamento |
|---|---|
| `ANALYZE` | Analisa sem modificar arquivos. |
| `EXECUTE` | Analisa e executa alterações permitidas. |
| `REPORT` | Gera relatório técnico. |
| `AUDIT` | Audita riscos e recomendações sem alterar arquivos. |

### Seleção da pasta

O botão `Selecionar pasta` abre o seletor nativo do Windows através do runner.

Somente caminhos dentro de `PROJECTS_HOST_ROOT` são aceitos. O runner também impede leitura de arquivos fora da pasta selecionada.

### Comandos executados

OpenCode:

```powershell
opencode run "<prompt completo em uma única linha>"
```

Claude Code:

```powershell
claude -p "<prompt completo em uma única linha>" --output-format text
```

Quando um modelo é definido no agente, o runner acrescenta o argumento correspondente do CLI.

### Prompt do agente

O prompt é enviado como um único argumento e uma única linha:

```text
prompt global | ambiente imutável | perfil | instruções do usuário | chamado GLPI | solicitação | formato final
```

Ordem:

1. `GLOBAL_AGENT_PROMPT`.
2. Regras imutáveis do ambiente.
3. Perfil do agente.
4. Instruções personalizadas.
5. Conteúdo completo do chamado.
6. Solicitação atual.
7. Formato esperado da resposta.

### Teste do agente

O botão `Testar agente` executa um oneshot somente leitura na pasta selecionada. O teste só é considerado válido quando o CLI retorna:

```text
AGENT_TEST_OK
```

## Ciclo automático do agente

1. O agente recebe uma conta GLPI própria.
2. O monitor consulta chamados recentes.
3. Quando um chamado aberto é atribuído à conta do agente, o contexto completo é carregado.
4. Uma tarefa GLPI é criada para a execução.
5. O CLI roda no Windows dentro da pasta configurada.
6. Saída, erro, duração e código de saída são persistidos.
7. A tarefa GLPI é concluída com o resultado e o tempo real.
8. O chamado fica como `Pendente` para revisão humana.
9. O agente nunca soluciona nem fecha o chamado.
10. Um novo acompanhamento humano posterior permite nova execução.

O Gerente também pode delegar uma instrução diretamente, por exemplo:

```text
No chamado #39, pede pro Claude subir a correção para homologação.
```

Nesse fluxo, a instrução é registrada no chamado e o chamado é atribuído ao agente. O monitor entrega o contexto completo na próxima execução.

## Aprovação de permissões

Por padrão, execuções automáticas começam sem permissões elevadas.

- OpenCode recebe negação para edição, shell e webfetch.
- Claude usa o modo padrão de permissões.
- Um bloqueio gera uma pendência no GLPI e na Central.
- O card pode ser movido para a lista Pendente do Trello.
- O usuário pode dizer `aprovar #42` ou `negar #42`.
- Ao aprovar, o agente é reexecutado com permissões elevadas.
- Mesmo após aprovação, o chamado retorna para `Pendente`.

## Grafana e incidentes

O Grafana é a porta única de observabilidade. O middleware descobre os dashboards
e consulta os três datasources configurados:

| Fonte | Uso |
|---|---|
| Loki | Erros de aplicação, autenticação, CORS, HMAC e eventos de segurança presentes nos logs. |
| Prometheus | Disponibilidade, CPU, memória, disco, reinícios, HTTP 5xx, latência e respostas 401/403. |
| Wazuh/OpenSearch | Eventos SIEM de alta severidade, regras, agentes e evidências de segurança. |

O catálogo de dashboards é redescoberto periodicamente. Telemetria normal não
vira chamado por si só: o scanner aplica detectores e limites para identificar
anomalias. Incidentes Prometheus são resolvidos quando a métrica normaliza;
eventos Loki e Wazuh são agrupados por assinatura para evitar duplicação.

Webhook:

```text
POST /webhooks/grafana
```

### Alerta firing

1. Verifica a fingerprint para impedir duplicação.
2. Busca evidências relacionadas no Grafana.
3. Solicita análise estruturada ao Gemini.
4. Cria chamado no GLPI.
5. Cria card no Trello quando habilitado.
6. Persiste a correlação.
7. Notifica Slack e Telegram.

Um novo firing com a mesma fingerprint adiciona acompanhamento ao chamado existente.

### Alerta resolved

1. Localiza o incidente aberto.
2. Soluciona o chamado GLPI.
3. Move o card para concluídos.
4. Atualiza o estado persistido.
5. Notifica Slack e Telegram.

## Sincronização GLPI e Trello

A sincronização usa polling e executa isoladamente cada etapa.

### Descoberta

- Card criado manualmente no Trello gera chamado no GLPI.
- Chamado aberto criado manualmente no GLPI gera card no Trello.
- Incidente e requisição usam listas e labels diferentes.

### Itens sincronizados

| GLPI | Trello |
|---|---|
| Followup | Comentário |
| Tarefa | Item da checklist `Tarefas (GLPI)` |
| Documento | Anexo enviado |
| Técnico atribuído | Membro e lista Em andamento |
| Solucionado/fechado | Lista Concluídos |

A tabela `sync_items` mantém os pares já propagados e evita loops de sincronização.

Mover um card para concluídos soluciona o chamado. Retirar o card de concluídos ou reabrir o chamado também reabre o outro lado.

## Slack

Existem duas integrações:

- `SLACK_WEBHOOK_URL`: notificações simples de incidentes.
- `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`: conversa bidirecional via Socket Mode.

`SLACK_CHANNEL` define canais para notificações proativas e pode conter vários IDs separados por vírgula.

## Telegram

Configure:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_CHAT_IDS=
```

`TELEGRAM_ALLOWED_CHAT_IDS` aceita IDs separados por vírgula. O bot mantém histórico próprio por chat e suporta texto e anexos.

## Consumo

A tela Consumo registra chamadas do Gemini para:

- Gerente.
- Análise de incidentes.
- Embeddings do RAG.

São armazenados tokens de entrada, saída, total e custo estimado. As estimativas são operacionais e devem ser conferidas com a tabela de preços vigente do provedor.

## Relatórios

A tela Relatórios consolida dados diretamente do GLPI e permite:

- períodos rápidos: hoje, semana, mês e ano;
- intervalo de datas personalizado;
- base temporal por criação, atualização ou solução;
- todos os técnicos ou uma seleção específica;
- inclusão opcional de chamados sem técnico;
- filtros por status e tipo;
- indicadores de volume, ativos, resolvidos, taxa e tempo médio de resolução;
- distribuição por status e produtividade por técnico;
- tarefas concluídas, acompanhamentos e detalhes de cada chamado;
- exportação do mesmo conteúdo em PDF.

O backend pagina até 5000 chamados do GLPI por relatório e limita a concorrência das consultas de detalhes para não sobrecarregar a API.

## Ferramentas de qualidade

A tela Ferramentas executa verificações técnicas fora do fluxo de chamados.

| Ferramenta | O que faz |
|---|---|
| Visual | Regressão visual com execução automatizada e relatório em PDF. |
| Pentest | Verifica headers, CORS, TLS, webhooks, rate limit, OWASP ZAP opcional, SAST e SCA. |
| Stress | Executa cenários de carga e registra duração, tokens, saída e relatório. |

Cada execução possui:

- histórico por tipo;
- passo a passo em tempo real;
- status `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED` ou `TIMED_OUT`;
- achados estruturados quando aplicável;
- relatório em Markdown e PDF;
- cancelamento pela interface quando ainda está em execução.

### Pentest, SAST e SCA

O Pentest combina sondas HTTP in-process com análises opcionais no código:

- headers de segurança;
- CORS;
- TLS;
- webhooks sem assinatura;
- rate limit de login quando autorizado;
- OWASP ZAP quando marcado na interface;
- Semgrep para SAST;
- `npm audit` e Trivy para SCA.

Quando um projeto cadastrado é um diretório guarda-chuva com várias aplicações,
a interface consulta os subprojetos e mostra um segundo dropdown. Assim o SAST e
o SCA podem rodar apenas em uma aplicação específica, por exemplo:

```text
Backoffice-Client
Backoffice-Server
Omni-InboxAI
OmniPay/api
OmniPay/checkout-ui
Servidor-IA
Servidor-IA-v2
```

A detecção local é feita pelo runner Windows em `POST /fs/subprojects`, limitada
à raiz `PROJECTS_HOST_ROOT`. O backend também valida `subPath` antes de executar:
caminhos absolutos e tentativas de sair do projeto com `..` são rejeitados.

Em projetos remotos por SSH, a detecção usa manifestos conhecidos em subpastas,
como `package.json`, `go.mod`, `pom.xml`, `composer.json`, `Cargo.toml`,
`requirements.txt`, `pyproject.toml` e `Gemfile`.

## Variáveis de ambiente

### Obrigatórias

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | Conexão PostgreSQL. |
| `GLPI_API_URL` | Base da API REST do GLPI. |
| `GLPI_WEB_URL` | URL acessível pelo navegador, usada nos links diretos dos chamados. |
| `GLPI_APP_TOKEN` | App Token do GLPI. |
| `GLPI_USER_TOKEN` | User Token do usuário técnico da integração. |
| `GEMINI_API_KEY` | Chave da API Gemini. |
| `CONFIG_ENCRYPTION_KEY` | Chave usada para criptografar segredos persistidos. |

### Aplicação e runner

| Variável | Padrão | Descrição |
|---|---|---|
| `NODE_ENV` | `development` | Ambiente. |
| `PORT` | `3333` | Porta do middleware. |
| `LOG_LEVEL` | `info` | Nível do Pino. |
| `RUNNER_URL` | `http://host.docker.internal:3340` | URL usada pelo middleware. |
| `RUNNER_PORT` | `3340` | Porta do runner Windows. |
| `RUNNER_TOKEN` | `local-runner-token` | Token compartilhado entre middleware e runner. |
| `RUN_TIMEOUT_MS` | `300000` | Timeout padrão das execuções. |
| `PROJECTS_HOST_ROOT` | `..` | Raiz Windows permitida para projetos. |
| `SELF_CODE_PATH` | `DEV/GPI-TRELLO/aiops-middleware` | Caminho do middleware dentro da raiz. |
| `AGENT_POLL_INTERVAL_MS` | `15000` | Intervalo do monitor de agentes. |

### Inteligência artificial

| Variável | Padrão | Descrição |
|---|---|---|
| `GEMINI_MODEL` | `gemini-2.5-flash` | Modelo da análise de incidentes. |
| `MANAGER_MODEL` | `gemini-2.5-flash` | Modelo global do Gerente. |
| `GLOBAL_AGENT_PROMPT` | vazio | Prompt aplicado a todos os agentes. |
| `MANAGER_PROJECT_CONTEXT` | vazio | Contexto fixo do ambiente para o Gerente. |
| `MANAGER_CONTEXT_CACHE_ENABLED` | `true` | Context caching das regras fixas do Gerente (entrada cacheada custa ~10% do preço). |
| `GEMINI_BATCH_EMBEDDINGS_ENABLED` | `true` | Batch API nos embeddings do reindex RAG (50% de desconto). |
| `ANTHROPIC_API_KEY` | vazio | Chave encaminhada ao runner quando configurada. |
| `OPENAI_API_KEY` | vazio | Chave encaminhada ao runner quando configurada. |
| `OPENCODE_API_KEY` | vazio | Chave encaminhada ao runner quando configurada. |
| `QDRANT_URL` | `http://qdrant:6333` | Endereço do Qdrant. |

### Integrações

| Variável | Descrição |
|---|---|
| `GRAFANA_URL` | URL do Grafana para Loki, Prometheus, Wazuh e descoberta de dashboards. |
| `GRAFANA_SA_TOKEN` | Token de Service Account do Grafana. |
| `LOKI_SCAN_ENABLED` | Ativa detecção automática em logs do Loki. |
| `LOKI_SCAN_ENVIRONMENTS` | Ambientes Loki separados por vírgula. |
| `OBSERVABILITY_SCAN_ENABLED` | Ativa o scanner Prometheus/Wazuh. |
| `OBSERVABILITY_SCAN_INTERVAL_MS` | Intervalo do scanner unificado. |
| `OBSERVABILITY_MAX_PER_CYCLE` | Limite de chamados novos por ciclo e fonte. |
| `PROMETHEUS_CPU_THRESHOLD` | Limite percentual de CPU do host. |
| `PROMETHEUS_MEMORY_THRESHOLD` | Limite percentual de memória do host. |
| `PROMETHEUS_DISK_THRESHOLD` | Limite percentual de uso do disco. |
| `PROMETHEUS_SERVICE_CPU_THRESHOLD` | Limite de CPU por serviço. |
| `PROMETHEUS_5XX_RATE_THRESHOLD` | Limite de respostas 5xx por segundo. |
| `PROMETHEUS_LATENCY_THRESHOLD_SECONDS` | Limite da latência HTTP p95. |
| `PROMETHEUS_AUTH_FAILURE_THRESHOLD` | Limite de 401/403 em cinco minutos. |
| `WAZUH_MIN_LEVEL` | Nível mínimo Wazuh que abre incidente. |
| `WAZUH_SCAN_LOOKBACK_MIN` | Janela de consulta dos eventos Wazuh. |
| `TRELLO_API_KEY` | API Key do Trello. |
| `TRELLO_TOKEN` | Token do Trello. |
| `TRELLO_LIST_ID_INCIDENT` | Lista de backlog de incidentes. |
| `TRELLO_LIST_ID_REQUEST` | Lista de backlog de requisições. |
| `TRELLO_LIST_ID_IN_PROGRESS` | Lista Em andamento. |
| `TRELLO_LIST_ID_PENDING` | Lista Pendente. |
| `TRELLO_LIST_ID_DONE` | Lista Concluídos. |
| `SYNC_INTERVAL_MS` | Intervalo de sincronização, mínimo de 5000 ms. |
| `GLPI_AGENT_PROFILE_ID` | Perfil técnico usado nas contas criadas. |
| `SLACK_WEBHOOK_URL` | Webhook para notificações. |
| `SLACK_BOT_TOKEN` | Token `xoxb` do bot. |
| `SLACK_APP_TOKEN` | Token `xapp` do Socket Mode. |
| `SLACK_CHANNEL` | IDs para avisos proativos. |
| `TELEGRAM_BOT_TOKEN` | Token do bot Telegram. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Chats permitidos. |

## API

As rotas da Central usam o prefixo `/api`.

| Método | Rota | Função |
|---|---|---|
| `GET` | `/healthz` | Liveness. |
| `GET` | `/readyz` | Readiness do PostgreSQL. |
| `POST` | `/webhooks/grafana` | Webhook do Grafana. |
| `GET` | `/api/dashboard` | Métricas da visão geral. |
| `GET` | `/api/observability/preview` | Prévia dos detectores sem abrir chamados. |
| `GET/PUT` | `/api/settings` | Leitura e gravação de configurações. |
| `GET/POST` | `/api/agents` | Lista e cria agentes. |
| `PUT/DELETE` | `/api/agents/:id` | Atualiza ou remove agente. |
| `POST` | `/api/agents/:id/test` | Executa teste oneshot. |
| `POST` | `/api/agents/:id/glpi-account` | Cria conta GLPI do agente. |
| `GET` | `/api/runs` | Histórico de execuções. |
| `GET` | `/api/incidents` | Incidentes persistidos. |
| `GET` | `/api/manager/channels` | Conversas conhecidas. |
| `GET` | `/api/manager/channels/available-glpi-users` | Contas ativas do GLPI. |
| `POST` | `/api/manager/channels/account` | Cria ou vincula conta ao canal. |
| `GET` | `/api/manager/messages` | Histórico de uma conversa. |
| `GET` | `/api/manager/models` | Modelos Gemini disponíveis. |
| `POST` | `/api/manager/chat` | Envia mensagem ao Gerente. |
| `GET` | `/api/plans` | Planos de chamados. |
| `POST` | `/api/knowledge/reindex` | Reindexa o RAG. |
| `GET/POST` | `/api/views` | Lista e cria telas personalizadas. |
| `PUT/DELETE` | `/api/views/:id` | Atualiza ou remove tela. |
| `GET` | `/api/usage` | Resumo de consumo. |
| `GET` | `/api/reports/options` | Técnicos, status e tipos disponíveis para filtros. |
| `POST` | `/api/reports/preview` | Gera a prévia estruturada do relatório. |
| `POST` | `/api/reports/pdf` | Gera e baixa o relatório em PDF. |
| `GET` | `/api/tools/projects` | Projetos disponíveis para SAST/SCA. |
| `GET` | `/api/tools/projects/:id/subprojects` | Detecta aplicações internas de um projeto. |
| `GET` | `/api/tools/runs` | Histórico das ferramentas, com filtro opcional por tipo. |
| `GET` | `/api/tools/runs/:id` | Detalhe de uma execução de ferramenta. |
| `GET` | `/api/tools/runs/:id/report.pdf` | PDF do relatório de uma execução. |
| `POST` | `/api/tools/runs/:id/cancel` | Cancela execução em andamento. |
| `POST` | `/api/tools/:kind/run` | Dispara `visual`, `pentest`, `load` ou `stress`. |
| `GET` | `/api/audit` | Auditoria. |
| `POST` | `/api/system/pick-folder` | Abre o seletor Windows. |
| `POST` | `/api/mcp` | Endpoint MCP JSON-RPC. |

## Scripts

| Comando | Função |
|---|---|
| `npm run dev` | Desenvolvimento com reload. |
| `npm run build` | Compila TypeScript. |
| `npm start` | Executa `dist/server.js`. |
| `npm run typecheck` | Valida tipos sem gerar saída. |
| `npm run prisma:generate` | Gera o Prisma Client. |
| `npm run prisma:migrate` | Cria e aplica migration de desenvolvimento. |
| `npm run prisma:deploy` | Aplica migrations pendentes. |
| `npm run runner` | Inicia o runner local do Windows. |

## Modelo de dados

Principais tabelas:

| Tabela | Conteúdo |
|---|---|
| `incidents` | Correlação Grafana, GLPI, Trello e análise da IA. |
| `sync_items` | Pares sincronizados de comentários, tarefas e anexos. |
| `agents` | Configuração dos agentes locais. |
| `agent_runs` | Execuções, prompts, saídas, erros e duração. |
| `agent_approvals` | Pedidos de aprovação de permissões. |
| `tool_runs` | Execuções das ferramentas Visual, Pentest e Stress, incluindo steps, achados e relatório. |
| `codebase_projects` | Projetos e conexões locais/SSH usados por agentes, análise de código e ferramentas. |
| `ticket_plans` | Planos colaborativos de chamados. |
| `ticket_channels` | Sessão responsável por aprovações de um chamado. |
| `chat_accounts` | Conta GLPI vinculada a cada conversa. |
| `chat_ticket_links` | Chamados anunciados e acompanhados por canal. |
| `manager_messages` | Histórico do Gerente por canal. |
| `app_settings` | Configurações persistidas e segredos criptografados. |
| `token_usage` | Tokens e custo estimado. |
| `audit_logs` | Auditoria das ações. |
| `custom_views` | Telas externas configuradas na Central. |

## Estrutura

```text
aiops-middleware/
|-- prisma/
|   |-- migrations/
|   `-- schema.prisma
|-- public/
|   |-- app.js
|   |-- index.html
|   `-- styles.css
|-- runner/
|   `-- server.mjs
|-- src/
|   |-- config/
|   |-- controllers/
|   |-- lib/
|   |-- repositories/
|   |-- routes/
|   |-- schemas/
|   |-- services/
|   |-- utils/
|   |-- app.ts
|   `-- server.ts
|-- .env.example
|-- docker-compose.yml
|-- Dockerfile
|-- package.json
`-- tsconfig.json
```

## Segurança

- Não versione `.env`.
- Use tokens dedicados e com menor privilégio possível.
- Troque os valores padrão de `CONFIG_ENCRYPTION_KEY` e `RUNNER_TOKEN`.
- Restrinja `PROJECTS_HOST_ROOT`.
- O runner rejeita caminhos fora da raiz permitida.
- Apenas variáveis de API explicitamente permitidas são encaminhadas aos CLIs.
- O container do middleware roda com usuário sem privilégios.
- Use HTTPS e autenticação reversa antes de expor a Central.
- Anexos do chat aceitam até 25 MB na interface; o payload HTTP suporta até 30 MB.

## Limitações atuais

- A sincronização GLPI/Trello usa polling.
- A descoberta trabalha com até 100 chamados recentes e a seleção administrativa consulta até 1000 usuários do GLPI por chamada.
- Não existe suíte automatizada de testes no `package.json`.
- O webhook do Grafana não possui autenticação própria.
- A Central Web não possui autenticação nativa.
- O custo de tokens é uma estimativa local.
- Os limites de anomalia do Prometheus precisam ser calibrados conforme o tráfego real.
- Alguns sites podem bloquear ou limitar o uso como tela incorporada.
- Contas GLPI de agentes automáticos são exclusivas por agente.
- Uma conversa possui apenas uma conta GLPI, mas a mesma conta pode ser vinculada a vários canais.

## Operação

Comandos úteis:

```powershell
docker compose up -d --build
docker ps
docker logs aiops_middleware --tail 200
```

Validação:

```powershell
npm run typecheck
npm run build
Invoke-RestMethod http://localhost:3333/healthz
Invoke-RestMethod http://localhost:3333/readyz
Invoke-RestMethod http://localhost:3340/healthz
```

Para alterações de schema:

```powershell
npm run prisma:generate
npm run prisma:migrate
```
