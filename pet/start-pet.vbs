' ============================================================
'  dsh-whale-pet one-click launcher (dsh 0.2.0-rc.2 stack)
'  1) starts dsh web hidden (if http://127.0.0.1:3080 is down)
'  2) waits until it responds
'  3) starts the desktop pet (if not already running)
'  No console windows at any point; pet lives in the system tray.
'  Rollback: run start-pet-rc6.vbs (dsh 0.1.0-rc.6 + %USERPROFILE%\.dsh-pet)
' ============================================================
Option Explicit

Const URL      = "http://127.0.0.1:3080"
Const DSH_BIN  = "C:\Users\clouddddd\dsh-pet-runtime\node_modules\@deepseek-ai\dsh\lib\bin.js"
Const NODE_EXE = "C:\Program Files\nodejs\node.exe"
Const PET_EXE  = "C:\Users\clouddddd\dsh-whale-pet\pet\node_modules\electron\dist\electron.exe"
Const PET_DIR  = "C:\Users\clouddddd\dsh-whale-pet\pet"
Const PNPM_DIR = "F:\文档\文档\deepseek work\.tooling\pnpm"

' Isolated DSH home for this stack. The rc.6 stack keeps .dsh-pet, the separate
' DeepSeek Harness desktop app keeps %USERPROFILE%\.dsh; the three never share state.
Const DSH_HOME_DIR = "C:\Users\clouddddd\.dsh-pet-020"

Dim shell
Set shell = CreateObject("WScript.Shell")

' A shell hosted inside another Electron app (the DSH desktop app's own terminal)
' exports ELECTRON_RUN_AS_NODE=1. Inherited by our children it turns electron.exe
' into plain Node and the pet window dies instantly, so drop it for this process tree.
On Error Resume Next
shell.Environment("PROCESS").Remove("ELECTRON_RUN_AS_NODE")
On Error GoTo 0

' pnpm must be on PATH for dsh web's plugin boot
shell.Environment("PROCESS")("PATH") = PNPM_DIR & ";" & shell.Environment("PROCESS")("PATH")
shell.Environment("PROCESS")("DSH_HOME") = DSH_HOME_DIR

' ---- helper: is the DSH web up? ----
Function IsUp(u)
  On Error Resume Next
  Dim x
  Set x = CreateObject("MSXML2.XMLHTTP")
  x.open "GET", u, False
  x.setTimeouts 2000, 2000, 2000, 2000
  x.send
  IsUp = (x.status = 200) Or (x.status = 401)
  On Error GoTo 0
End Function

' ---- 1) dsh web ----
If IsUp(URL) Then
  ' already running, nothing to do
Else
  ' Start hidden. node.exe is launched DIRECTLY (no cmd /c wrapper): WScript.Shell.Run
  ' parses quoted paths itself, while cmd /c would strip the quotes and split on the
  ' space in "C:\Program Files\nodejs\node.exe". Window style 0 = fully hidden.
  ' --no-open keeps dsh 0.2 from popping the system browser on every boot; the pet's
  ' own window is the GUI.
  shell.CurrentDirectory = PET_DIR
  shell.Run """" & NODE_EXE & """ """ & DSH_BIN & """ --profile web --port 3080 --no-open", 0, False
End If

' ---- 2) wait up to 60s ----
Dim i
i = 0
Do While (Not IsUp(URL)) And (i < 30)
  WScript.Sleep 2000
  i = i + 1
Loop

' ---- 3) desktop pet ----
Dim petFound
petFound = False
Dim proc
For Each proc In GetObject("winmgmts:\\.\root\cimv2").ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='electron.exe'")
  petFound = True
  Exit For
Next
If Not petFound Then
  shell.CurrentDirectory = PET_DIR
  shell.Run """" & PET_EXE & """ """ & PET_DIR & """", 0, False
End If