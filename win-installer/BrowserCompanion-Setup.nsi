; =========================================================================
; BrowserCompanion-Setup.nsi — 浏览器搭子 Windows 安装程序
; 用 NSIS 3 编译（macOS 上 makensis 可直接编译出 Windows .exe）
;   makensis BrowserCompanion-Setup.nsi
; 产物：dist-packages/BrowserCompanion-Setup-<ver>.exe（免管理员，按用户安装）
; =========================================================================

Unicode true
ManifestDPIAware true

!include "MUI2.nsh"

!define APPNAME      "BrowserCompanion"
!define APPCN        "浏览器搭子"
!define VERSION      "4.11.2"
!define PUBLISHER    "BrowserCompanion"
!define HELPFILE     "BrowserCompanion 安装指南.html"
!define LAUNCHER     "reload-extension.bat"

Name "${APPNAME} ${VERSION} 安装向导"
OutFile "..\dist-packages\BrowserCompanion-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\${APPNAME}"
InstallDirRegKey HKCU "Software\${APPNAME}" "InstallDir"
RequestExecutionLevel user

VIProductVersion "4.11.2.0"
VIAddVersionKey /LANG=2052 "ProductName" "${APPNAME}"
VIAddVersionKey /LANG=2052 "FileDescription" "${APPCN} 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "${PUBLISHER}"

!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"
; 完成页：可选「运行重新载入扩展」→ 浏览器带扩展启动 = 装完即用
!define MUI_FINISHPAGE_RUN "$INSTDIR\${LAUNCHER}"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动浏览器并载入扩展（推荐勾选）"
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\${HELPFILE}"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "查看安装指南"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; 简中优先，英文兜底（macOS 版 NSIS 自带语言文件）
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; ---------------------------------------------------------------- 安装段
Section "Install" SecInstall
  SetShellVarContext current
  SetOutPath "$INSTDIR\extension"
  File /r "extension\*.*"

  SetOutPath "$INSTDIR"
  File "${HELPFILE}"
  File "${LAUNCHER}"

  ; 写版本信息与卸载器
  WriteRegStr HKCU "Software\${APPNAME}" "InstallDir" $INSTDIR
  WriteRegStr HKCU "Software\${APPNAME}" "Version" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" \
                 "DisplayName" "${APPCN} ${APPNAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" \
                 "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" \
                 "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" \
                 "Publisher" "${PUBLISHER}"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; 开始菜单 + 桌面快捷方式
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut  "$SMPROGRAMS\${APPNAME}\安装指南.lnk" "$INSTDIR\${HELPFILE}"
  CreateShortcut  "$SMPROGRAMS\${APPNAME}\重新载入扩展.lnk" "$INSTDIR\${LAUNCHER}"
  CreateShortcut  "$SMPROGRAMS\${APPNAME}\卸载 ${APPNAME}.lnk" "$INSTDIR\uninstall.exe"
  CreateShortcut  "$DESKTOP\${APPNAME} 安装指南.lnk" "$INSTDIR\${HELPFILE}"
SectionEnd

; ---------------------------------------------------------------- 卸载段
Section "Uninstall"
  SetShellVarContext current
  RMDir /r "$INSTDIR\extension"
  Delete "$INSTDIR\${HELPFILE}"
  Delete "$INSTDIR\${LAUNCHER}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APPNAME}\*.lnk"
  RMDir "$SMPROGRAMS\${APPNAME}"
  Delete "$DESKTOP\${APPNAME} 安装指南.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"
  DeleteRegKey HKCU "Software\${APPNAME}"
SectionEnd
