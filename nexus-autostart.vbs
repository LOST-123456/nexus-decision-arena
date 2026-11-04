' ---------------------------------------------------------------
'  Nexus - start the site (with a public tunnel) and keep it up.
'
'  Double-click this once. It launches scripts\serve-public.cmd
'  hidden (window style 0), so nothing can be closed by accident
'  and nothing disappears when a terminal is shut down.
'
'  That script brings up, in order:
'    - a Cloudflare quick tunnel (no account needed)
'    - the site itself on 127.0.0.1:3000
'  and rewrites the "Nexus public address" .url shortcut (root +
'  desktop) with the current public address, because a quick tunnel
'  domain changes on every restart.
'
'  A copy of this file sits in the Startup folder, so it also runs
'  by itself every time you log in.
'
'  Stop everything:   double-click stop-nexus.cmd
'  Current address:   logs\public-url.txt
'  Log:               logs\site.log
' ---------------------------------------------------------------
Option Explicit

Dim sh, root, command
Set sh = CreateObject("WScript.Shell")

root = "E:\nexus-p0-worktree"

If Not CreateObject("Scripting.FileSystemObject").FolderExists(root) Then
  MsgBox "Cannot find " & root, 16, "Nexus"
  WScript.Quit 1
End If

sh.CurrentDirectory = root
command = """" & root & "\scripts\serve-public.cmd"""

' 0 = hidden window, False = do not wait for it to finish.
sh.Run command, 0, False
