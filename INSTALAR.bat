@echo off
setlocal
echo ======================================
echo          INSTALADOR LIBRARIUM
echo ======================================
echo.
where py >nul 2>nul
if errorlevel 1 (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python 3 no esta instalado.
    echo Descargalo desde https://www.python.org/downloads/
    echo Marca "Add Python to PATH" durante la instalacion.
    pause
    exit /b 1
  )
)
echo Librarium ya esta listo para ejecutarse.
echo Ejecuta INICIAR_LIBRARIUM.bat para abrirlo.
echo.
pause

