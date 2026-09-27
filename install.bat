@echo off
REM Raven Installation Script for Windows
REM This script adds Raven to the system PATH and creates a desktop shortcut

echo ========================================
echo Raven Installation Script
echo ========================================
echo.

REM Check if Python is installed
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Python is not installed or not in PATH
    echo Please install Python 3.9+ from https://python.org
    pause
    exit /b 1
)

echo Python found:
python --version
echo.

REM Get Raven directory
set "RAVEN_DIR=%~dp0"
set "RAVEN_DIR=%RAVEN_DIR:~0,-1%"

echo Raven directory: %RAVEN_DIR%
echo.

REM Install Raven in development mode
echo Installing Raven...
cd /d "%RAVEN_DIR%"
python -m pip install -e .
if %errorlevel% neq 0 (
    echo ERROR: Failed to install Raven
    pause
    exit /b 1
)

echo.
echo Raven installed successfully!
echo.

REM Add to system PATH
echo Adding Raven to system PATH...
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%b"
if defined USER_PATH (
    echo %USER_PATH% | findstr /i "%RAVEN_DIR%" >nul
    if %errorlevel% neq 0 (
        reg add "HKCU\Environment" /v Path /t REG_EXPAND_SZ /d "%USER_PATH%;%RAVEN_DIR%" /f
        echo Added to user PATH
    ) else (
        echo Already in PATH
    )
) else (
    reg add "HKCU\Environment" /v Path /t REG_EXPAND_SZ /d "%RAVEN_DIR%" /f
    echo Added to user PATH
)

echo.
echo Creating desktop shortcut...
set "SHORTCUT=%USERPROFILE%\Desktop\Raven.lnk"
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT%'); $s.TargetPath = 'python'; $s.Arguments = '-m raven.cli_new'; $s.WorkingDirectory = '%RAVEN_DIR%'; $s.Save()"

echo.
echo ========================================
echo Installation Complete!
echo ========================================
echo.
echo You can now run Raven by typing:
echo   raven
echo.
echo Or use the desktop shortcut
echo.
echo NOTE: You may need to restart your terminal
echo       for PATH changes to take effect.
echo.
pause
