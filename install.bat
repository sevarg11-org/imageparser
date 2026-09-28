@echo off
setlocal EnableExtensions

rem ============================================================================
rem  Image Parser installer
rem   1. Ensures Node.js (with npm) and immich-go are installed (via winget)
rem   2. Runs npm install and builds the UI
rem   3. Creates an "Image Parser" shortcut on the desktop
rem ============================================================================

set "APP_NAME=Image Parser"
set "SCRIPT_PATH=%~f0"
set "NO_PAUSE="
if /i "%~1"=="/nopause" set "NO_PAUSE=1"
set "NODE_WINGET_ID=OpenJS.NodeJS.LTS"
set "IMMICH_WINGET_ID=simulot.immich-go"

rem Project root without the trailing backslash (a trailing "\" breaks quoting).
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%" || goto :fail

echo.
echo === %APP_NAME% installer ===
echo Project directory: %ROOT%
echo.

rem ---------------------------------------------------------------------------
rem  Node.js / npm  (Vite 8 requires Node 20.19+ or 22.12+)
rem ---------------------------------------------------------------------------
echo [1/5] Checking Node.js...
call :check_node
if errorlevel 1 (
    echo Node.js 20.19+ / 22.12+ not found. Installing %NODE_WINGET_ID%...
    call :winget_install %NODE_WINGET_ID% || goto :fail
    call :refresh_path
    call :check_node
    if errorlevel 1 (
        echo ERROR: Node.js is still missing or too old after installation.
        echo        If you use nvm or another version manager, switch to Node 22 LTS and re-run.
        echo        Otherwise, close this window and run install.bat again in a new terminal.
        goto :fail
    )
)
for /f "delims=" %%V in ('node --version') do echo       Node.js %%V found.

where npm >nul 2>&1
if errorlevel 1 (
    echo ERROR: npm was not found on PATH even though Node.js is installed.
    goto :fail
)

rem ---------------------------------------------------------------------------
rem  immich-go (used for the Immich upload feature)
rem ---------------------------------------------------------------------------
echo [2/5] Checking immich-go...
where immich-go >nul 2>&1
if errorlevel 1 (
    echo immich-go not found. Installing %IMMICH_WINGET_ID%...
    call :winget_install %IMMICH_WINGET_ID% || goto :fail
    call :refresh_path
    where immich-go >nul 2>&1
    if errorlevel 1 (
        echo ERROR: immich-go is still not on PATH after installation.
        echo        Close this window and run install.bat again in a new terminal.
        goto :fail
    )
)
for /f "delims=" %%P in ('where immich-go') do (
    echo       immich-go found at %%P
    goto :immich_done
)
:immich_done

rem ---------------------------------------------------------------------------
rem  npm install
rem ---------------------------------------------------------------------------
echo [3/5] Installing npm dependencies...
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed.
    goto :fail
)

rem ---------------------------------------------------------------------------
rem  Build the UI so the desktop shortcut can run without the dev server
rem ---------------------------------------------------------------------------
echo [4/5] Building the application...
call npm run build
if errorlevel 1 (
    echo ERROR: npm run build failed.
    goto :fail
)

rem ---------------------------------------------------------------------------
rem  Desktop shortcut
rem ---------------------------------------------------------------------------
echo [5/5] Creating desktop shortcut...
set "ELECTRON_EXE=%ROOT%\node_modules\electron\dist\electron.exe"
set "ICON_PATH=%ROOT%\assets\imageparser.ico"
if not exist "%ELECTRON_EXE%" (
    echo ERROR: Electron executable not found at "%ELECTRON_EXE%".
    goto :fail
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference = 'Stop';" ^
    "$desktop = [Environment]::GetFolderPath('Desktop');" ^
    "$lnkPath = Join-Path $desktop ($env:APP_NAME + '.lnk');" ^
    "$shell = New-Object -ComObject WScript.Shell;" ^
    "$lnk = $shell.CreateShortcut($lnkPath);" ^
    "$lnk.TargetPath = $env:ELECTRON_EXE;" ^
    "$lnk.Arguments = [char]34 + $env:ROOT + [char]34;" ^
    "$lnk.WorkingDirectory = $env:ROOT;" ^
    "$lnk.IconLocation = $env:ICON_PATH + ',0';" ^
    "$lnk.Description = $env:APP_NAME;" ^
    "$lnk.Save();" ^
    "Write-Host ('      Shortcut created: ' + $lnkPath)"
if errorlevel 1 (
    echo ERROR: Failed to create the desktop shortcut.
    goto :fail
)

echo.
echo === Installation complete. Launch "%APP_NAME%" from your desktop. ===
echo.
call :maybe_pause
endlocal
exit /b 0

rem ============================================================================
rem  Subroutines
rem ============================================================================

:check_node
where node >nul 2>&1 || exit /b 1
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)||(a===20&&b>=19)?0:1)"
exit /b %errorlevel%

:winget_install
where winget >nul 2>&1
if errorlevel 1 (
    echo ERROR: winget is not available. Install "App Installer" from the Microsoft Store,
    echo        or install %~1 manually, then re-run install.bat.
    exit /b 1
)
winget install --id %~1 --exact --silent --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
    echo ERROR: winget failed to install %~1.
    exit /b 1
)
exit /b 0

:refresh_path
rem Reload PATH from the registry so newly installed tools are visible in this session.
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%P"
exit /b 0

:maybe_pause
rem Pause only when launched by double-click (so the window doesn't vanish).
if defined NO_PAUSE exit /b 0
echo %cmdcmdline% | find /i "%SCRIPT_PATH%" >nul && pause
exit /b 0

:fail
echo.
echo Installation did not complete.
call :maybe_pause
endlocal
exit /b 1
