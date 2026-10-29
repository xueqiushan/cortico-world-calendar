' Shared Calendar - silent start (use this for startup folder)
' Runs in background with NO window, so you cannot close it by accident.
'
' Setup: Win+R -> shell:startup -> drop a shortcut of this file there
' Stop:  run stop.vbs (it kills only this calendar's node process)

Dim fso, shell, here
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here

' --- Single instance guard -------------------------------------------
' If something is already answering on 8787, the service is up.
' Do NOT start a second copy: the server would silently fall over to
' 8788, and the Edge app window always opens 8787 -> blank calendar.
Dim http
Set http = CreateObject("MSXML2.XMLHTTP")
already = False
On Error Resume Next
http.open "GET", "http://127.0.0.1:8787/api/calendar", False
http.setTimeouts 500, 800, 800, 1500
http.send
If Err.Number = 0 Then
  If http.status = 200 Then already = True
End If
Err.Clear
On Error GoTo 0

If already Then
  WScript.Quit 0
End If

' --- Start -------------------------------------------------------------
' 0 = hidden window, False = do not wait
shell.Run "cmd /c node server.mjs", 0, False
