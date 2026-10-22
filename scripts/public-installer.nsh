; Public setup uses the protected App/Private/Workspace/Source layout.
; Existing installations require the in-app update or an explicit migration.
!macro publicPowerShell
  ; NSIS is normally a 32-bit process. Sysnative reaches native 64-bit PS;
  ; the fallback supports a future native 64-bit NSIS host.
  StrCpy $R9 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$R9" +2 0
    StrCpy $R9 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
!macroend

!macro publicGuard MODE
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=exomina-public-guard.ps1 "${PROJECT_DIR}\scripts\install-public.ps1"
  !insertmacro publicPowerShell
  nsExec::ExecToLog '"$R9" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\exomina-public-guard.ps1" -Mode ${MODE} -AppDir "$PROGRAMFILES64\Exomina\App"'
  Pop $R8
  ${If} $R8 != 0
    MessageBox MB_OK|MB_ICONSTOP "Exomina setup stopped before changing program files. The destination must be empty for installation, protected from ordinary writes, and free of linked paths. Existing profiles need an explicit migration. See the setup log for details." /SD IDOK
    SetErrorLevel 10
    Quit
  ${EndIf}
!macroend

!macro customInit
  ; Refuse registered copies before electron-builder can run an old uninstaller,
  ; including per-user registration which an ordinary account could modify.
  ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R2 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ReadRegStr $R3 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $R0 != ""
  ${OrIf} $R1 != ""
  ${OrIf} $R2 != ""
  ${OrIf} $R3 != ""
    MessageBox MB_OK|MB_ICONSTOP "Exomina already has a registered installation. Use its in-app update, or migrate the existing profile before running public setup." /SD IDOK
    SetErrorLevel 10
    Quit
  ${EndIf}
  !insertmacro publicGuard Preflight
  StrCpy $INSTDIR "$PROGRAMFILES64\Exomina\App"
!macroend

; Never let the default process-name fallback close another Exomina copy.
!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    ; Silent uninstall calls this before initMultiUser can elevate. The
    ; protected removal guard runs in customUnInit after that elevation.
  !else
    !insertmacro publicGuard Preflight
    ; The stock all-users section would run any HKCU UninstallString next.
    ; A fresh protected install has no previous version to migrate. Keep the
    ; all-users shell context, but skip that untrusted per-user execution path.
    StrCpy $installMode "public-fresh"
  !endif
!macroend

!macro customInstall
  StrCpy $installMode "all"
  !insertmacro publicPowerShell
  nsExec::ExecToLog '"$R9" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\app.asar.unpacked\scripts\install-public.ps1" -Mode Initialize -AppDir "$INSTDIR" -UninstallerName "${UNINSTALL_FILENAME}"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Public setup could not finish. The log contains the reason. No existing profile was migrated. Repair setup before starting Exomina." /SD IDOK
    Abort
  ${EndIf}
  WriteRegStr HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString '"$PROGRAMFILES64\Exomina\Setup\Uninstall.exe" /allusers'
  WriteRegStr HKLM "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString '"$PROGRAMFILES64\Exomina\Setup\Uninstall.exe" /allusers /S'
!macroend

!macro customUnInit
  StrCpy $INSTDIR "$PROGRAMFILES64\Exomina\App"
  !insertmacro publicGuard ValidateRemoval
!macroend

!macro customRemoveFiles
  ; Release NSIS's current-directory handle before the helper removes App.
  SetOutPath "$TEMP"
  !insertmacro publicPowerShell
  nsExec::ExecToLog '"$R9" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\app.asar.unpacked\scripts\install-public.ps1" -Mode Remove -AppDir "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Program removal was stopped because the installed files could not be verified. Private, Workspace and Source were kept." /SD IDOK
    Abort
  ${EndIf}
  Delete "$PROGRAMFILES64\Exomina\Setup\Uninstall.exe"
  RMDir "$PROGRAMFILES64\Exomina\Setup"
!macroend
