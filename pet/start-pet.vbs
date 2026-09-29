' ============================================================
'  dsh-whale-pet one-click launcher (windowless, self-contained)
'  1) starts dsh web hidden (if http://127.0.0.1:3080 is down)
'  2) waits until it responds
'  3) starts the desktop pet (if not already running)
'  No console windows at any point; pet lives in the system tray.
' ============================================================
Option Explicit

Const URL      = "http://127.0.0.1:3080"
Const DSH_BIN  = "C:\Users\clouddddd\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh\lib\bin.js"
Const NODE_EXE = "C:\Program Files\nodejs\node.exe"
Const PET_EXE  = "C:\Users\clouddddd\dsh-whale-pet\pet\node_modules\electron\dist\electron.exe"
Const PET_DIR  = "C:\Users\clouddddd\dsh-whale-pet\pet"
Const PNPM_DIR = "F:\文档\文档\deepseek work\.tooling\pnpm"

Dim shell
Set shell = CreateObject("WScript.Shell")

' pnpm must be on PATH for dsh web's plugin boot
shell.Environment("PROCESS")("PATH") = PNPM_DIR & ";" & shell.Environment("PROCESS")("PATH")

' ---- helper: is the DSH web up? ----
Function IsUp(u)
  On Error Resume Next
  Dim x
  Set x = CreateObject("MSXML2.XMLHTTP")
  x.open "GET", u, False
  x.setTimeouts 2000, 2000, 2000, 2000
  x.send
  IsUp = (x.status = 200)
  On Error GoTo 0
End Function

' ---- 1) dsh web ----
If IsUp(URL) Then
  ' already running, nothing to do
Else
  ' Start hidden. We launch node.exe DIRECTLY (no cmd /c wrapper):
  ' WScript.Shell.Run parses the quoted paths itself, so the space in
  ' "C:\Program Files\nodejs\node.exe" is safe — cmd /c would strip the
  ' leading quotes and split the path at the space. WorkingDirectory is set
  ' so the harness boots from a valid cwd. Window style 0 = fully hidden.
  shell.CurrentDirectory = PET_DIR
  shell.Run """" & NODE_EXE & """ """ & DSH_BIN & """ --profile web", 0, False
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
