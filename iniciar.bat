@echo off
title Overall Financas
cd /d "%~dp0"

set "PHP=C:\xampp\php\php.exe"
if not exist "%PHP%" (
  echo.
  echo  Nao encontrei o PHP do XAMPP em %PHP%
  echo  Edite este arquivo e ajuste a variavel PHP, ou sirva a pasta por outro servidor.
  echo.
  pause
  exit /b 1
)

echo.
echo  ================================================
echo   Overall Financas
echo  ================================================
echo.
echo   No computador:  http://localhost:8123
echo.
echo   No celular (mesma rede Wi-Fi), use um destes:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo      http:/^/%%a:8123
echo.
echo   Feche esta janela para parar o servidor.
echo.

start "" http://localhost:8123
"%PHP%" -S 0.0.0.0:8123 -t "%~dp0"
