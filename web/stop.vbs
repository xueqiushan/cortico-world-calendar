' Shared Calendar - stop the background service
' Double-click this to stop it (no need to hunt in Task Manager).

Dim shell
Set shell = CreateObject("WScript.Shell")

' Kill only the process listening on 8787, not every node.exe.
shell.Run "cmd /c for /f ""tokens=5"" %a in ('netstat -ano ^| findstr :8787 ^| findstr LISTENING') do taskkill /pid %a /f", 0, True

MsgBox "Calendar service stopped." & vbCrLf & vbCrLf & _
       "The desktop window will show 'no data' - that is expected." & vbCrLf & _
       "To start again: double-click start.bat", _
       0, "Shared Calendar"
