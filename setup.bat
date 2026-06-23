@echo off
setlocal enabledelayedexpansion
title GPI-TRELLO - Setup Automatizado

echo ============================================================
echo   GPI-TRELLO - Instalacao e Inicializacao Completa
echo ============================================================
echo.

:: ------------------------------------------------------------------
:: 1. Verificar Docker
:: ------------------------------------------------------------------
echo [1/7] Verificando Docker...
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERRO] Docker nao encontrado ou nao esta rodando.
    echo        Instale o Docker Desktop e inicie-o antes de continuar.
    echo        https://www.docker.com/products/docker-desktop/
    pause
    exit /b 1
)
echo       Docker OK.

:: ------------------------------------------------------------------
:: 2. Verificar Node.js
:: ------------------------------------------------------------------
echo [2/7] Verificando Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERRO] Node.js nao encontrado.
    echo        Instale o Node.js 20 ou superior: https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=1 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
if !NODE_MAJOR! lss 20 (
    echo [ERRO] Node.js !NODE_MAJOR! encontrado. Versao minima: 20.
    pause
    exit /b 1
)
echo       Node.js OK (versao !NODE_MAJOR!).

:: ------------------------------------------------------------------
:: 3. Criar .env se nao existir
:: ------------------------------------------------------------------
echo [3/7] Verificando arquivo .env...
set ENV_FILE=aiops-middleware\.env
if not exist "%ENV_FILE%" (
    if exist "aiops-middleware\.env.example" (
        copy "aiops-middleware\.env.example" "%ENV_FILE%" >nul
        echo.
        echo ============================================================
        echo   ATENCAO: Arquivo .env criado a partir do .env.example
        echo   Edite %ENV_FILE% com suas chaves ANTES de continuar:
        echo   - GEMINI_API_KEY
        echo   - GLPI_APP_TOKEN
        echo   - GLPI_USER_TOKEN
        echo   - TRELLO_API_KEY / TRELLO_TOKEN (opcional)
        echo   - SLACK / TELEGRAM (opcional)
        echo ============================================================
        echo.
        set /p ENV_READY="Pressione ENTER apos configurar o .env (ou CTRL+C para sair)..."
    ) else (
        echo [ERRO] .env.example nao encontrado em aiops-middleware\
        pause
        exit /b 1
    )
) else (
    echo       .env ja existe, pulando criacao.
)

:: ------------------------------------------------------------------
:: 4. Instalar dependencias npm
:: ------------------------------------------------------------------
echo [4/7] Instalando dependencias npm...
cd aiops-middleware
call npm install --omit=dev
if %errorlevel% neq 0 (
    echo [ERRO] Falha ao instalar dependencias npm.
    cd ..
    pause
    exit /b 1
)
cd ..
echo       Dependencias instaladas.

:: ------------------------------------------------------------------
:: 5. Subir containers Docker
:: ------------------------------------------------------------------
echo [5/7] Subindo containers Docker (GLPI + PostgreSQL + Qdrant + Middleware)...
docker compose up -d --build
if %errorlevel% neq 0 (
    echo [ERRO] Falha ao subir os containers Docker.
    pause
    exit /b 1
)
echo       Containers iniciados. Aguardando healthchecks...

:: Aguardar GLPI (ate 120s)
echo          Aguardando GLPI ficar pronto...
set GLPI_READY=0
for /l %%i in (1,1,24) do (
    curl -s -o nul -w "%%{http_code}" http://localhost:8080 2>nul | find "200" >nul 2>&1
    if !errorlevel! equ 0 (
        set GLPI_READY=1
        goto :glpi_ok
    )
    timeout /t 5 /nobreak >nul
)
:glpi_ok
if !GLPI_READY! equ 1 (
    echo          GLPI pronto.
) else (
    echo          [AVISO] GLPI nao respondeu apos 120s. Verifique com: docker logs glpi_app
)

:: Aguardar Middleware (ate 120s)
echo          Aguardando Middleware ficar pronto...
set MID_READY=0
for /l %%i in (1,1,24) do (
    curl -s -o nul -w "%%{http_code}" http://localhost:3333/healthz 2>nul | find "200" >nul 2>&1
    if !errorlevel! equ 0 (
        set MID_READY=1
        goto :mid_ok
    )
    timeout /t 5 /nobreak >nul
)
:mid_ok
if !MID_READY! equ 1 (
    echo          Middleware pronto.
) else (
    echo          [AVISO] Middleware nao respondeu apos 120s. Verifique com: docker logs aiops_middleware
)

:: ------------------------------------------------------------------
:: 6. Instalar PM2 (se necessario)
:: ------------------------------------------------------------------
echo [6/7] Verificando PM2...
where pm2 >nul 2>&1
if %errorlevel% neq 0 (
    echo       Instalando PM2 globalmente...
    call npm install -g pm2
    if %errorlevel% neq 0 (
        echo [ERRO] Falha ao instalar PM2.
        pause
        exit /b 1
    )
)
echo       PM2 OK.

:: ------------------------------------------------------------------
:: 7. Iniciar Runner com PM2
:: ------------------------------------------------------------------
echo [7/7] Iniciando Runner Windows com PM2...

:: Para runner existente se ja estiver rodando
pm2 delete aiops-agent-runner >nul 2>&1

cd aiops-middleware
call pm2 start runner/server.mjs --name aiops-agent-runner --interpreter node
if %errorlevel% neq 0 (
    echo [ERRO] Falha ao iniciar o runner com PM2.
    cd ..
    pause
    exit /b 1
)
call pm2 save
cd ..
echo       Runner iniciado via PM2.

:: Aguardar Runner
echo          Aguardando Runner ficar pronto...
set RUNNER_READY=0
for /l %%i in (1,1,6) do (
    curl -s -o nul -w "%%{http_code}" http://localhost:3340/healthz 2>nul | find "200" >nul 2>&1
    if !errorlevel! equ 0 (
        set RUNNER_READY=1
        goto :runner_ok
    )
    timeout /t 2 /nobreak >nul
)
:runner_ok

:: ------------------------------------------------------------------
:: Resumo final
:: ------------------------------------------------------------------
echo.
echo ============================================================
echo   SETUP CONCLUIDO
echo ============================================================
echo.
echo   Acessos:
echo     Central de Comando : http://localhost:3333
echo     GLPI               : http://localhost:8080
echo     Runner Windows     : http://localhost:3340/healthz
echo     Qdrant             : http://localhost:6333
echo.
echo   Status PM2:
call pm2 status
echo.
echo   Status Docker:
docker compose ps
echo.
echo   Logs do Middleware (ultimas 20 linhas):
docker logs aiops_middleware --tail 20
echo.
echo ============================================================
echo   Para parar tudo:
echo     pm2 stop aiops-agent-runner
echo     docker compose down
echo ============================================================
echo.
pause
