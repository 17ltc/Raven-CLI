@echo off
rem Raven installer for Windows: double-click or run install.cmd
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ is required. Install it from https://nodejs.org and run this again.
  exit /b 1
)
echo Installing Raven dependencies...
call npm install --omit=optional --no-audit --no-fund
if errorlevel 1 exit /b 1
node bin\raven.js setup
rem Keep this cmd process usable immediately when install.cmd was called from cmd.
set "PATH=%USERPROFILE%\.raven\bin;%PATH%"
echo.
echo If you launched this from PowerShell, refresh that existing session with:
echo   $env:Path = "$env:USERPROFILE\.raven\bin;$env:Path"
pause
