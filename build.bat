@echo off
REM RL3D exe build: venv -> deps -> PyInstaller onefile.
REM ASCII only: this .bat must stay ASCII because cmd mis-parses UTF-8 Korean
REM under a non-UTF codepage (esp. with a Korean username in the path).
REM Calls the venv python directly instead of activate.bat (activate breaks on
REM Korean paths like C:\Users\<hangul>\...).
setlocal
cd /d "%~dp0"

set "PY=.venv\Scripts\python.exe"

if not exist ".venv" (
  echo [1/3] Creating virtualenv...
  python -m venv .venv
)

echo [2/3] Installing dependencies...
"%PY%" -m pip install --upgrade pip
"%PY%" -m pip install -r requirements.txt
if errorlevel 1 goto :err

echo [3/3] Building exe...
REM web folder is bundled and loaded via _MEIPASS (resource_path).
"%PY%" -m PyInstaller --noconfirm --onefile --windowed --name RL3D --add-data "web;web" main.py
if errorlevel 1 goto :err

echo.
echo Done: dist\RL3D.exe
endlocal
exit /b 0

:err
echo.
echo BUILD FAILED. See messages above.
endlocal
exit /b 1
