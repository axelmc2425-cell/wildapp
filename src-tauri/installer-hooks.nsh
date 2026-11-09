; Tauri v2 NSIS installer hooks. The helper copies itself to %ProgramFiles%\MyBrainFocus and
; registers the Focus Room services (install is per-machine, so this runs elevated).

!macro NSIS_HOOK_POSTINSTALL
  ExecWait '"$INSTDIR\resources\focus-helper.exe" install' $0
  ${If} $0 <> 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "MyBrain was installed, but the Focus Room helper could not be installed or upgraded (exit code $0). Focus Room blocking will not work until it is installed. If a lock is active, the upgrade is deferred until it ends."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ExecWait '"$INSTDIR\resources\focus-helper.exe" uninstall' $0
  ${If} $0 <> 0
    MessageBox MB_OK|MB_ICONSTOP "MyBrain Focus Room has an active lock; uninstall is blocked until it ends or your partner unlocks it."
    Abort
  ${EndIf}
!macroend
