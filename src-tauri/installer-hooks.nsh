; Tauri v2 NSIS installer hooks. The helper copies itself to %ProgramFiles%\MyBrainFocus and
; registers the Focus Room services (install is per-machine, so this runs elevated).
;
; focus-helper exit codes: 0 ok, 1 refused (a lock is pending, or no uninstall permit: a partner code or the waiting period), 3 any other failure.
;
; UNVERIFIED (no Tauri sources were available offline): the macro names NSIS_HOOK_POSTINSTALL /
; NSIS_HOOK_PREUNINSTALL, the installerHooks key, the $UpdateMode variable (assumed to be 1 when
; the installer/uninstaller runs for an app update) and LogicLib being included by the template.
; Check all of them on the first CI build.

!macro NSIS_HOOK_POSTINSTALL
  ClearErrors
  ExecWait '"$INSTDIR\resources\focus-helper.exe" install' $0
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "MyBrain was installed, but the Focus Room helper could not be started (could not run focus-helper.exe). Focus Room blocking will not work until it is installed." /SD IDOK
  ${ElseIf} $0 <> 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "MyBrain was installed, but the Focus Room helper could not be installed or upgraded (exit code $0). Focus Room blocking will not work until it is installed. If a lock is active, the upgrade is deferred until it ends." /SD IDOK
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; An app update must never be blocked by the helper, so skip this in update mode.
  ${If} $UpdateMode <> 1
    ClearErrors
    ExecWait '"$INSTDIR\resources\focus-helper.exe" uninstall' $0
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION "The Focus Room helper could not be run to remove its services. Uninstall will continue; the helper services may remain installed." /SD IDOK
    ${ElseIf} $0 = 1
      MessageBox MB_OK|MB_ICONSTOP "Uninstall is protected by MyBrain Focus Room. Open MyBrain, then Focus Room, then Uninstall protection, ask your partner for a code or start the waiting period, then run the uninstaller again." /SD IDOK
      Abort
    ${ElseIf} $0 <> 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "The Focus Room helper could not be fully removed (exit code $0). Uninstall will continue; the helper services may remain installed." /SD IDOK
    ${EndIf}
  ${EndIf}
!macroend
