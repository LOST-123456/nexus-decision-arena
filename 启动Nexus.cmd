@echo off
REM ---------------------------------------------------------------
REM  Nexus - one double-click starter (ASCII only).
REM
REM  Two cases, both handled here:
REM    - site already running  -> just open it in the browser
REM    - site not running      -> start it in a minimised window,
REM                               with the tunnel, and say what to
REM                               wait for
REM
REM  This exists because the .vbs starter is silent by design, and a
REM  silent start is indistinguishable from "nothing happened".
REM ---------------------------------------------------------------
setlocal
cd /d "%~dp0"

netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul
if %ERRORLEVEL% EQU 0 (
  echo.
  echo   The site is already running. Opening it now...
  echo.
  start "" "http://localhost:3000"
  ping -n 4 127.0.0.1 >nul
  exit /b 0
)

echo.
echo   Starting Nexus: local site + public tunnel.
echo.
echo   - A minimised "Nexus" window will appear on your taskbar.
echo     Do not close it; closing it stops the site.
echo   - Give it ~40 seconds.
echo   - Then open the desktop shortcut "Nexus" (public) or
echo     http://localhost:3000 here.
echo   - Current public address: logs\public-url.txt
echo.
start "Nexus" /min cmd /c "%~dp0scripts\serve-public.cmd"
ping -n 6 127.0.0.1 >nul
exit /b 0
