@echo off
cd /d "%~dp0"
echo ============================================
echo  Fuentes de Espana - Servidor de fotos
echo ============================================
echo.
echo Abriendo http://localhost:3000 ...
start "" http://localhost:3000
echo.
call npm start
pause