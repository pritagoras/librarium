@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  set "PY=py"
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo No se encontro Python. Instala Python 3 desde https://www.python.org/downloads/
    echo Durante la instalacion marca "Add Python to PATH".
    pause
    exit /b 1
  )
  set "PY=python"
)
set PORT=8765
start "" http://127.0.0.1:%PORT%
echo Iniciando Librarium en http://127.0.0.1:%PORT%
%PY% -m http.server %PORT% --bind 127.0.0.1
pause

