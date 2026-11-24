@echo off
setlocal
echo ======================================
echo          INSTALADOR LIBRARIUM
echo ======================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js no esta instalado.
  echo Descargalo desde https://nodejs.org/ e instala la version 22 o superior.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo No se encontro npm. Reinstala Node.js e incluye npm en PATH.
  pause
  exit /b 1
)
if not exist "node_modules\vite\bin\vite.js" (
  echo Instalando dependencias de Librarium...
  call npm install
  if errorlevel 1 (
    echo No se pudieron instalar las dependencias.
    pause
    exit /b 1
  )
)
echo Librarium ya esta listo para ejecutarse.
echo Ejecuta INICIAR_LIBRARIUM.bat para abrirlo.
echo.
pause

