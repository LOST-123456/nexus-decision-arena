@echo off
REM ---------------------------------------------------------------
REM  Nexus - compatibility entry point (ASCII only).
REM
REM  This file used to run scripts\serve-all.mjs in its own loop,
REM  which starts the site but NOT the public tunnel. That is why a
REM  reboot quietly turned "Nexus" into "a site only this computer
REM  can open": the Startup shortcut pointed here, and nothing in
REM  this chain ever started cloudflared.
REM
REM  There is now exactly one definition of "start Nexus", and it is
REM  scripts\serve-public.cmd: tunnel first, then the site, wired to
REM  the tunnel origin, with its own restart loop. This file only
REM  forwards to it, so any old shortcut, registry entry or habit
REM  that still names serve-forever.cmd gets the tunnel too.
REM
REM  Do not copy the serve-all loop back in here. If the site needs
REM  different settings, change serve-public.cmd - it is the single
REM  source of truth.
REM
REM  Stop: run stop-nexus.cmd (it writes logs\stopped.flag first, so
REM  the loop does not start everything again three seconds later).
REM ---------------------------------------------------------------
setlocal
cd /d "%~dp0.."

call "%~dp0serve-public.cmd"
exit /b %ERRORLEVEL%
