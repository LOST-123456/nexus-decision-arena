@echo off
REM ---------------------------------------------------------------
REM  Nexus - public launcher (ASCII only).
REM
REM  Brings up Cloudflare quick tunnel + site together, so the same
REM  thing that is on 127.0.0.1:3000 is reachable from a phone or
REM  another computer. The tunnel domain changes on every restart, so
REM  scripts\serve-public.mjs rewrites the .url shortcut in the project
REM  root (and the desktop copy) each time and prints the address.
REM
REM  The loop below is only a backstop: serve-public.mjs already
REM  restarts itself. This catches the case where that process is
REM  killed outright.
REM ---------------------------------------------------------------
setlocal
cd /d "%~dp0.."

set "PORT=3000"
set "DATABASE_URL=postgres://nexus:nexus@localhost:5433/nexus_demo"
set "LLM_MODE=mock"

REM Cross-examination concurrency. Each row = three model calls; ten rows run
REM in parallel finish in one call deep instead of three. Match this to the
REM quota the model provider actually gives you.
set "CHALLENGE_CONCURRENCY=10"

REM Local requests must never go through a system proxy.
set "NO_PROXY=127.0.0.1,localhost"
set "no_proxy=127.0.0.1,localhost"
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "http_proxy="
set "https_proxy="

if not exist "logs" mkdir "logs"

REM ---------------------------------------------------------------
REM  Pick a log file that can actually be written.
REM
REM  This is not paranoia; it happened. A stale launcher kept
REM  logs\site.log open, so every ">> logs\site.log" below failed at
REM  the shell level: the echoes vanished, `node` never ran because its
REM  redirection could not be opened, and the launcher looked like it
REM  silently did nothing. Nothing was listening, nothing was logged,
REM  and the site stayed down until someone noticed.
REM
REM  So: probe first, fall back to a dated file if the usual one is
REM  wedged. The message below names the file in use, so the next
REM  person knows where to look.
REM ---------------------------------------------------------------
set "LOGFILE=logs\site.log"
2>nul (>>"%LOGFILE%" echo.) && goto log_ready
set "LOGFILE=logs\site-%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%.log"
2>nul (>>"%LOGFILE%" echo.) && goto log_ready
REM Last resort: no log at all, but the site still has to start.
set "LOGFILE=nul"

:log_ready

where node >nul 2>&1
if errorlevel 1 (
  echo [%TIME%] node is not on PATH, cannot start. >> "%LOGFILE%"
  exit /b 1
)

del /q "logs\stopped.flag" 2>nul

echo [%TIME%] launcher using log %LOGFILE% >> "%LOGFILE%"

:loop
if exist "logs\stopped.flag" (
  echo [%TIME%] stopped.flag present, public watchdog exiting. >> "%LOGFILE%"
  exit /b 0
)
REM The database lives in a Docker container, and Docker Desktop is not part of
REM any autostart on this machine. That check used to be a .cmd called from
REM here; any mistake in it made this launcher vanish right after "checking",
REM with nothing in the log to say why. It now lives in serve-public.mjs, where
REM every step is logged and a failure can only make the site answer 500 - it
REM can never stop the launcher.

echo [%TIME%] starting serve-public >> "%LOGFILE%"
node scripts\serve-public.mjs >> "%LOGFILE%" 2>&1
echo [%TIME%] serve-public exited code=%ERRORLEVEL%, restarting in 5s >> "%LOGFILE%"
ping -n 6 127.0.0.1 >nul
goto loop
