@echo off
REM ---------------------------------------------------------------
REM  Nexus - one-port launcher with a VISIBLE window (core on 4100,
REM  web UI on 3000). Use this one when you want to watch the logs.
REM
REM  For everyday use prefer nexus-autostart.vbs: no window, restarts
REM  itself forever, and it is in the Startup folder.
REM
REM  Keep this file ASCII-only: cmd.exe reads .cmd as GBK, and CJK
REM  characters get split into broken commands.
REM ---------------------------------------------------------------
setlocal
cd /d "%~dp0"

set "PORT=3000"
REM Site uses its own database. Never point this at nexus_test_e2e:
REM integration tests wipe that database, and the site's projects go
REM with it.
set "DATABASE_URL=postgres://nexus:nexus@localhost:5433/nexus_demo"
set "LLM_MODE=mock"

REM Optional web search. Fill these in to actually search the web;
REM results are candidates only and are never treated as verified
REM evidence. Any JSON search proxy works:
REM   POST {query, limit} -> {results:[{title,url,snippet}]}
REM Leaving them unset means "not connected", and the UI badge says so.
REM set "SEARCH_API_URL=https://your-search-endpoint/search"
REM set "SEARCH_API_KEY=sk-..."
REM set "SEARCH_API_PROVIDER=tavily"

REM Local requests must never go through a system proxy.
set "NO_PROXY=127.0.0.1,localhost"
set "no_proxy=127.0.0.1,localhost"
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "http_proxy="
set "https_proxy="

echo.
echo   Nexus
echo   ------------------------------------------------------------
echo   URL      : http://localhost:3000
echo   Settings : http://localhost:3000/settings/model
echo   Demo     : http://localhost:3000/sessions/demo
REM The password is not printed here. It lives in .data\owner-password.txt
REM (git-ignored) and can be rotated with: node scripts\rotate-password.mjs owner
echo   Login    : owner / see .data\owner-password.txt
echo   Core API : 127.0.0.1:4100 (internal, do not open directly)
echo   ------------------------------------------------------------
echo   Until a model is configured, starting a review and extracting
echo   claims are refused on purpose - that is not a bug, it stops the
echo   product from inventing a conclusion about a project no model read.
echo   ------------------------------------------------------------
echo   DO NOT CLOSE THIS WINDOW. Closing it stops the site.
echo   Unexpected exits restart automatically (up to 5 times).
echo   ------------------------------------------------------------
echo.

REM Starting a second copy only collides on 3000/4100 and prints an
REM EADDRINUSE nobody can act on. Check first, then decide.
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if %ERRORLEVEL% EQU 0 (
  echo [aborted] Port 3000 is already answering - the site is already up.
  echo   Since nexus-autostart.vbs is in your Startup folder, that is
  echo   probably this. Just open http://localhost:3000 in the browser.
  echo   To stop it first, run stop-nexus.cmd, then run this file again.
  echo.
  pause
  exit /b 1
)

set /a RESTARTS=0

:loop
set /a RESTARTS+=1
node scripts/serve-all.mjs
set "CODE=%ERRORLEVEL%"

if %CODE% EQU 0 (
  echo.
  echo [serve-all] exited normally ^(code=0^).
  pause
  exit /b 0
)

if %RESTARTS% GEQ 5 (
  echo.
  echo [serve-all] exited %RESTARTS% times in a row ^(last code=%CODE%^), giving up.
  echo   Usual causes: Postgres not running on 5433, missing .next build,
  echo   or the port is taken. Read the error above, then run this again.
  echo.
  pause
  exit /b 1
)

echo.
echo [serve-all] exited ^(code=%CODE%^), restarting in 3s ^(try %RESTARTS%/5^).
echo   If you meant to stop the site, just close this window.
timeout /t 3 /nobreak >nul
goto loop
