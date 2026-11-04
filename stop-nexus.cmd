@echo off
REM ---------------------------------------------------------------
REM  Nexus - stop the site (ASCII only).
REM
REM  Sets logs\stopped.flag FIRST, otherwise serve-forever.cmd would
REM  see the dead child and start it again three seconds later.
REM ---------------------------------------------------------------
setlocal enabledelayedexpansion
cd /d "%~dp0"

if not exist "logs" mkdir "logs"
echo stopped %DATE% %TIME% > "logs\stopped.flag"

REM Stop the tunnel and the supervisor by pid. Killing by image name would
REM also take down any other cloudflared the machine is running for
REM something else, so the pid files written by serve-public.mjs win.
if exist "logs\serve-public.pid" (
  set /p SPID=<"logs\serve-public.pid"
  taskkill /PID !SPID! /T /F >nul 2>&1
)
if exist "logs\tunnel.pid" (
  set /p TPID=<"logs\tunnel.pid"
  taskkill /PID !TPID! /F >nul 2>&1
)
del /q "logs\serve-public.pid" 2>nul
del /q "logs\tunnel.pid" 2>nul

for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING"') do taskkill /PID %%P /F >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":4100 " ^| findstr "LISTENING"') do taskkill /PID %%P /F >nul 2>&1

echo.
echo   Nexus stopped (site + public tunnel).
echo   Start again: double-click nexus-autostart.vbs
echo   It also starts by itself the next time you log in.
echo.
ping -n 5 127.0.0.1 >nul
