@echo off
chcp 65001 >nul
setlocal
set EXT=%LOCALAPPDATA%\BrowserCompanion\extension
echo ============================================
echo   BrowserCompanion - launching with extension
echo   Extension dir: %EXT%
echo ============================================

set FOUND=0

set CHROME1=%ProgramFiles%\Google\Chrome\Application\chrome.exe
set CHROME2=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
set CHROME3=%LocalAppData%\Google\Chrome\Application\chrome.exe
for %%P in ("%CHROME1%" "%CHROME2%" "%CHROME3%") do (
  if exist %%P (
    echo [Chrome] launching: %%~P
    start "" %%P --load-extension="%EXT%"
    set FOUND=1
    goto :chrome_done
  )
)
:chrome_done

set EDGE1=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
set EDGE2=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe
for %%P in ("%EDGE1%" "%EDGE2%") do (
  if exist %%P (
    echo [Edge] launching: %%~P
    start "" %%P --load-extension="%EXT%"
    set FOUND=1
    goto :edge_done
  )
)
:edge_done

set BRAVE1=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe
set BRAVE2=%ProgramFiles(x86)%\BraveSoftware\Brave-Browser\Application\brave.exe
for %%P in ("%BRAVE1%" "%BRAVE2%") do (
  if exist %%P (
    echo [Brave] launching: %%~P
    start "" %%P --load-extension="%EXT%"
    set FOUND=1
    goto :brave_done
  )
)
:brave_done

if "%FOUND%"=="0" (
  echo.
  echo [!] No Chromium browser found in default locations.
  echo     Please open your browser and load the extension manually:
  echo     chrome://extensions  -^>  Developer mode  -^>  Load unpacked
  echo     Folder: %EXT%
)
echo.
echo Done. If the extension icon does not appear, see the Install Guide
echo (desktop shortcut) for the 3-click manual load steps.
pause
