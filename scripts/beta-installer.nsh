; Private beta only. Exomina.exe remains the runtime executable while the
; installation folder, shortcut and registration are distinct from personal use.
!undef APP_FILENAME
!define APP_FILENAME "Exomina Beta"
!include "${PROJECT_DIR}\scripts\beta-installer-path-limits.nsh"

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInit
  ; Force the per-user branch even during silent installs. Never elevate.
  !insertmacro setInstallModePerUser
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Exomina Beta requires 64-bit Windows 10 or Windows 11." /SD IDOK
    SetErrorLevel 10
    Quit
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "Exomina Beta requires Windows 10 or newer. Windows 11 is recommended." /SD IDOK
    SetErrorLevel 10
    Quit
  ${EndIf}
  ; Standard per-user profiles work on Home editions too. Private access is
  ; verified by the app before opening data; EFS is an optional Windows mode.
!macroend

; Override electron-builder's process-name fallback. A shared Exomina.exe name
; must never result in closing the personal host or an unrelated installation.
; Loader-locked destination files cause a refusal; no process is terminated.
!macro customCheckAppRunning
  GetFullPathName $2 $INSTDIR
  StrLen $0 $2
  ${If} $0 > ${BETA_MAX_INSTALL_ROOT_CHARS}
    MessageBox MB_OK|MB_ICONSTOP "The Exomina Beta installation folder path is too long. Choose a shorter folder path (at most ${BETA_MAX_INSTALL_ROOT_CHARS} characters). No program files have been changed." /SD IDOK
    SetErrorLevel 10
    Quit
  ${EndIf}
  GetFullPathName $1 $TEMP
  StrLen $0 $1
  ${If} $0 > ${BETA_MAX_TEMP_ROOT_CHARS}
    MessageBox MB_OK|MB_ICONSTOP "The Windows temporary folder path is too long for this beta (at most ${BETA_MAX_TEMP_ROOT_CHARS} characters). Use a shorter temporary folder for this installer, then retry. No program files have been changed." /SD IDOK
    SetErrorLevel 10
    Quit
  ${EndIf}
  ; Verify the actual update staging root too; never remove program files
  ; before knowing that the previous version can be staged safely.
  ClearErrors
  InitPluginsDir
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "Windows could not create the temporary Exomina Beta installer folder. Choose a temporary folder writable by your Windows account, then retry. No program files have been changed." /SD IDOK
    SetErrorLevel 10
    Quit
  ${EndIf}
  StrCpy $1 "$PLUGINSDIR\old-install"
  StrLen $0 $1
  ${If} $0 > ${BETA_MAX_ATOMIC_TEMP_ROOT_CHARS}
    MessageBox MB_OK|MB_ICONSTOP "The temporary update folder path is too long for this beta. Use a shorter Windows temporary folder, then retry. No program files have been changed." /SD IDOK
    SetErrorLevel 10
    Quit
  ${EndIf}
  ${GetRoot} $2 $1
  StrCpy $1 "$1\"
  GetFullPathName $1 $1
  ${If} $2 == $1
  ${OrIf} $2 == "$PROFILE"
  ${OrIf} $2 == "$DOCUMENTS"
  ${OrIf} $2 == "$LOCALAPPDATA"
  ${OrIf} $2 == "$LOCALAPPDATA\Exomina\Private"
  ${OrIf} $2 == "$DOCUMENTS\Exomina\Private"
  ${OrIf} $2 == "$DOCUMENTS\Exomina\Workspace"
    Goto beta_reject_destination
  ${EndIf}
  IfFileExists "$INSTDIR\Exomina.exe" 0 beta_check_first_destination
  IfFileExists "$INSTDIR\exomina.distribution.json" 0 beta_reject_destination
  ; A marker alone is not ownership proof. Reinstall/uninstall is permitted
  ; only for this beta GUID's registered per-user installation at this path.
  ReadRegStr $1 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $1 == ""
    Goto beta_reject_destination
  ${EndIf}
  GetFullPathName $1 $1
  StrCmp $1 $2 beta_check_destination_lock beta_reject_destination
  beta_check_first_destination:
  FindFirst $1 $2 "$INSTDIR\*"
  beta_inspect_destination:
  ${If} $2 == ""
    FindClose $1
    Goto beta_destination_ready
  ${EndIf}
  ${If} $2 != "."
  ${AndIf} $2 != ".."
    FindClose $1
    Goto beta_reject_destination
  ${EndIf}
  FindNext $1 $2
  Goto beta_inspect_destination
  beta_reject_destination:
    MessageBox MB_OK|MB_ICONSTOP "Choose a new, empty Exomina Beta folder. Existing documents, projects, private-data folders and other Exomina installations cannot be used as the app installation folder." /SD IDOK
    SetErrorLevel 10
    Quit
  beta_check_destination_lock:
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\Exomina.exe", i 0x40000000, i 7, p 0, i 3, i 0, p 0) p.r0'
  ${If} $0 == -1
    MessageBox MB_OK|MB_ICONSTOP "Close Exomina Beta in this installation folder before continuing, or choose a folder writable by your Windows account. The installer will not close apps automatically." /SD IDOK
    SetErrorLevel 10
    Quit
  ${Else}
    System::Call 'kernel32::CloseHandle(p r0)'
  ${EndIf}
  beta_destination_ready:
!macroend

; electron-builder's default nonzero old-uninstaller result opens an error
; dialog without a silent default. Return a definite failure instead of hanging.
!macro customUnInstallCheck
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "The previous Exomina Beta installation could not be removed. Close Exomina Beta, check that its folder is writable, and retry. Your private data is stored outside the app folder." /SD IDOK
    SetErrorLevel 10
    Quit
  ${EndIf}
  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONSTOP "The previous Exomina Beta installation could not be removed. Close Exomina Beta and use shorter installation and temporary folder paths, then retry. Your private data is stored outside the app folder." /SD IDOK
    SetErrorLevel 10
    Quit
  ${EndIf}
  Return
!macroend

; afterPack places the distribution marker in the app image before compression.
; It contains installation policy only, never a private-data home path.
; Intentionally no customUnInstall or personal-data removal macro. The standard
; uninstaller removes this installation, its own shortcut and its own registry
; entry only. Documents/Local AppData private files are outside the app folder.
