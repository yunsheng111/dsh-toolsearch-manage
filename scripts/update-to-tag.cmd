@echo off
chcp 65001 >nul
rem Double-click launcher for update-to-tag.ps1.
rem
rem Two Windows behaviours make the .ps1 un-double-clickable on its own:
rem   1. .ps1 files open in Notepad by default, not in PowerShell.
rem   2. The default execution policy blocks unsigned scripts.
rem This wrapper starts PowerShell with -ExecutionPolicy Bypass for this one
rem process only, and pauses at the end so the output stays readable. Without
rem the pause the window closes the instant the script ends, which is how the
rem first report arrived: the window flashed past with nothing to act on.
rem
rem Usage:
rem   update-to-tag.cmd
rem   update-to-tag.cmd -Tag v0.1.0 -Profile desktop

setlocal
set "SCRIPT=%~dp0update-to-tag.ps1"

if not exist "%SCRIPT%" (
  echo.
  echo ERROR: update-to-tag.ps1 not found next to this launcher.
  echo        Expected: %SCRIPT%
  echo.
  pause
  exit /b 2
)

rem Prefer PowerShell 7; fall back to the built-in 5.1 when pwsh is absent.
set "PS="
where pwsh >nul 2>nul && set "PS=pwsh"
if not defined PS (
  where powershell >nul 2>nul && set "PS=powershell"
)
if not defined PS (
  echo.
  echo ERROR: no PowerShell found on PATH.
  echo.
  pause
  exit /b 2
)

"%PS%" -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo ---------------------------------------------
  echo  Installation did not complete ^(exit %RC%^).
  echo  Read the messages above, and the log under
  echo    %USERPROFILE%\.dsh\logs\
  echo ---------------------------------------------
)

rem The script also pauses on its own; this one catches the cases where it
rem exited before reaching that point.
pause
exit /b %RC%
