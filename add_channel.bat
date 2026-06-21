@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_SH=%SCRIPT_DIR%add_channel.sh"
set "PATH=%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%LOCALAPPDATA%\UniGetUI\Chocolatey\bin;%PATH%"

if "%~1"=="" (
  echo Usage: add_channel.bat ^<UC_CHANNEL_ID^> [@handle] [name]
  exit /b 1
)

set "BASH_EXE="

where bash.exe >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%I in ('where bash.exe 2^>nul') do (
    if not defined BASH_EXE set "BASH_EXE=%%I"
  )
)

if not defined BASH_EXE if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH_EXE=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASH_EXE if exist "%ProgramFiles%\Git\usr\bin\bash.exe" set "BASH_EXE=%ProgramFiles%\Git\usr\bin\bash.exe"
if not defined BASH_EXE if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "BASH_EXE=%ProgramFiles(x86)%\Git\bin\bash.exe"

if defined BASH_EXE (
  "%BASH_EXE%" "%SCRIPT_SH%" %*
  exit /b %errorlevel%
)

where wsl.exe >nul 2>nul
if not errorlevel 1 (
  wsl.exe bash -lc "cd '/mnt/c/Users/valen/Documents/GitHub/chromescribe' && bash ./add_channel.sh \"$@\"" -- %*
  exit /b %errorlevel%
)

echo ERROR: Could not find bash.exe.
echo Install Git for Windows or add Git Bash to PATH, then rerun this command.
exit /b 1
