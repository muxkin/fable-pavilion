# -*- coding: utf-8 -*-
Unicode True
!include "MUI2.nsh"
!include "x64.nsh"

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentSpaceNative"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define RUN_NAME "agent-space-native"
!define START_MENU_LINK "$SMPROGRAMS\Agent Space Adapter.lnk"
!define APP_NAME_RESOURCE 101
!define APP_NAME_EN "Fable Pavilion Adapter"
!define APP_NAME_ZH "子虚亭适配器"
Name "$(AdapterName)"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Agent Space Adapter"
RequestExecutionLevel user
SetCompressor /SOLID lzma
AllowSkipFiles off
VIProductVersion "${VERSION}.0"

!define MUI_ICON "${APP_ICON}"
!define MUI_UNICON "${APP_ICON}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\agent-space-native.exe"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "TradChinese"

!macro AdapterInstallerVersion LANG PRODUCT DESCRIPTION
  VIAddVersionKey /LANG=${LANG} "ProductName" "${PRODUCT}"
  VIAddVersionKey /LANG=${LANG} "FileDescription" "${DESCRIPTION}"
  VIAddVersionKey /LANG=${LANG} "FileVersion" "${VERSION}"
  VIAddVersionKey /LANG=${LANG} "LegalCopyright" "Agent Space contributors"
!macroend
!insertmacro AdapterInstallerVersion ${LANG_ENGLISH} "${APP_NAME_EN}" "${APP_NAME_EN} Setup"
!insertmacro AdapterInstallerVersion ${LANG_SIMPCHINESE} "${APP_NAME_ZH}" "${APP_NAME_ZH}安装程序"
!insertmacro AdapterInstallerVersion ${LANG_TRADCHINESE} "${APP_NAME_ZH}" "${APP_NAME_ZH}安裝程式"

LangString AdapterName ${LANG_ENGLISH} "${APP_NAME_EN}"
LangString AdapterName ${LANG_SIMPCHINESE} "${APP_NAME_ZH}"
LangString AdapterName ${LANG_TRADCHINESE} "${APP_NAME_ZH}"
LangString AdapterRequiresX64 ${LANG_ENGLISH} "This installer requires 64-bit Windows."
LangString AdapterRequiresX64 ${LANG_SIMPCHINESE} "此安装程序需要 64 位 Windows。"
LangString AdapterRequiresX64 ${LANG_TRADCHINESE} "此安裝程式需要 64 位元 Windows。"
LangString AdapterWriteFailed ${LANG_ENGLISH} "Could not replace ${APP_NAME_EN}. Quit it from the system tray, then click Retry. If it is already closed, check that you can write to the installation folder."
LangString AdapterWriteFailed ${LANG_SIMPCHINESE} "无法更新${APP_NAME_ZH}。请从任务栏右下角的托盘菜单退出适配器，再点「重试」。如果适配器已退出，请检查安装目录的写入权限。"
LangString AdapterWriteFailed ${LANG_TRADCHINESE} "無法更新${APP_NAME_ZH}。請從系統匣結束程式，再按一下「重試」。如果程式已結束，請檢查安裝資料夾的寫入權限。"
LangString AdapterInstallInUse ${LANG_ENGLISH} "Quit ${APP_NAME_EN} from the system tray before installing."
LangString AdapterInstallInUse ${LANG_SIMPCHINESE} "安装前请从系统托盘退出${APP_NAME_ZH}。"
LangString AdapterInstallInUse ${LANG_TRADCHINESE} "安裝前請從系統匣結束${APP_NAME_ZH}。"
LangString AdapterUninstallInUse ${LANG_ENGLISH} "Quit ${APP_NAME_EN} from the system tray before uninstalling."
LangString AdapterUninstallInUse ${LANG_SIMPCHINESE} "卸载前请从系统托盘退出${APP_NAME_ZH}。"
LangString AdapterUninstallInUse ${LANG_TRADCHINESE} "解除安裝前請從系統匣結束${APP_NAME_ZH}。"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "$(AdapterRequiresX64)" /SD IDOK
    SetErrorLevel 1
    Quit
  ${EndIf}
  SetRegView 64
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
retry_adapter:
  ClearErrors
  SetOverwrite try
  File "${PACKAGE_DIR}\agent-space-native.exe"
  SetOverwrite on
  IfErrors 0 adapter_written
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(AdapterWriteFailed)" /SD IDCANCEL IDRETRY retry_adapter
  SetErrorLevel 1
  Quit
adapter_written:
  File "${PACKAGE_DIR}\LICENSE"
  File "${PACKAGE_DIR}\README.txt"
  File "${PACKAGE_DIR}\THIRD-PARTY-NOTICES.txt"
  IfErrors in_use
!ifdef OFFICIAL_PLUGINS
  SetOutPath "$INSTDIR\official-plugins\codex"
  File "${PACKAGE_DIR}\official-plugins\codex\adapter.json"
  File "${PACKAGE_DIR}\official-plugins\codex\agent-space-adapter-codex.exe"
  File "${PACKAGE_DIR}\official-plugins\codex\LICENSE"
  File "${PACKAGE_DIR}\official-plugins\codex\THIRD-PARTY-NOTICES.txt"
  SetOutPath "$INSTDIR\official-plugins\dsh"
  File "${PACKAGE_DIR}\official-plugins\dsh\adapter.json"
  File "${PACKAGE_DIR}\official-plugins\dsh\agent-space-adapter-dsh.exe"
  File "${PACKAGE_DIR}\official-plugins\dsh\LICENSE"
  File "${PACKAGE_DIR}\official-plugins\dsh\THIRD-PARTY-NOTICES.txt"
  SetOutPath "$INSTDIR\official-plugins\antigravity"
  File "${PACKAGE_DIR}\official-plugins\antigravity\adapter.json"
  File "${PACKAGE_DIR}\official-plugins\antigravity\agent-space-adapter-antigravity.exe"
  File "${PACKAGE_DIR}\official-plugins\antigravity\LICENSE"
  File "${PACKAGE_DIR}\official-plugins\antigravity\THIRD-PARTY-NOTICES.txt"
  IfErrors in_use
  SetOutPath "$INSTDIR"
!endif
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "${START_MENU_LINK}" "$INSTDIR\agent-space-native.exe"
  System::Call 'shell32::SHSetLocalizedName(w "${START_MENU_LINK}", w "$INSTDIR\agent-space-native.exe", i ${APP_NAME_RESOURCE}) i .r0'
  ; SHCNE_UPDATEITEM with SHCNF_PATHW refreshes the application and shortcut at their existing paths.
  System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "$INSTDIR\agent-space-native.exe", p 0)'
  System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "${START_MENU_LINK}", p 0)'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "$(AdapterName)"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\agent-space-native.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  ReadRegStr $0 HKCU "${RUN_KEY}" "${RUN_NAME}"
  StrCmp $0 '$INSTDIR\agent-space-native.exe --background' 0 +2
  WriteRegStr HKCU "${RUN_KEY}" "${RUN_NAME}" '"$INSTDIR\agent-space-native.exe" --background'
  Goto done
in_use:
  MessageBox MB_OK|MB_ICONSTOP "$(AdapterInstallInUse)" /SD IDOK
  SetErrorLevel 1
  Quit
done:
SectionEnd

Section "Uninstall"
  SetRegView 64
  IfFileExists "$INSTDIR\agent-space-native.exe" 0 remove_files
  ClearErrors
  Delete "$INSTDIR\agent-space-native.exe"
  IfErrors in_use
remove_files:
  System::Call 'shell32::SHRemoveLocalizedName(w "${START_MENU_LINK}") i .r0'
  Delete "${START_MENU_LINK}"
  ReadRegStr $0 HKCU "${RUN_KEY}" "${RUN_NAME}"
  StrCmp $0 '"$INSTDIR\agent-space-native.exe" --background' remove_startup
  StrCmp $0 '$INSTDIR\agent-space-native.exe --background' 0 keep_startup
remove_startup:
  DeleteRegValue HKCU "${RUN_KEY}" "${RUN_NAME}"
keep_startup:
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\THIRD-PARTY-NOTICES.txt"
!ifdef OFFICIAL_PLUGINS
  Delete "$INSTDIR\official-plugins\codex\adapter.json"
  Delete "$INSTDIR\official-plugins\codex\agent-space-adapter-codex.exe"
  Delete "$INSTDIR\official-plugins\codex\LICENSE"
  Delete "$INSTDIR\official-plugins\codex\THIRD-PARTY-NOTICES.txt"
  RMDir "$INSTDIR\official-plugins\codex"
  Delete "$INSTDIR\official-plugins\dsh\adapter.json"
  Delete "$INSTDIR\official-plugins\dsh\agent-space-adapter-dsh.exe"
  Delete "$INSTDIR\official-plugins\dsh\LICENSE"
  Delete "$INSTDIR\official-plugins\dsh\THIRD-PARTY-NOTICES.txt"
  RMDir "$INSTDIR\official-plugins\dsh"
  Delete "$INSTDIR\official-plugins\antigravity\adapter.json"
  Delete "$INSTDIR\official-plugins\antigravity\agent-space-adapter-antigravity.exe"
  Delete "$INSTDIR\official-plugins\antigravity\LICENSE"
  Delete "$INSTDIR\official-plugins\antigravity\THIRD-PARTY-NOTICES.txt"
  RMDir "$INSTDIR\official-plugins\antigravity"
  RMDir "$INSTDIR\official-plugins"
!endif
  RMDir /r "$INSTDIR\gateway"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Goto done
in_use:
  MessageBox MB_OK|MB_ICONSTOP "$(AdapterUninstallInUse)" /SD IDOK
  SetErrorLevel 1
  Quit
done:
SectionEnd
