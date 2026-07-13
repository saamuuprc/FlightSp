@echo off
rem ============================================
rem  FlightSpy - Publicar cambios en produccion
rem  Doble clic y en ~1 minuto esta desplegado en
rem  https://saamuuprc.github.io/FlightSp/
rem ============================================
cd /d "%~dp0"
echo.
echo === Publicando FlightSpy ===
git add -A
git commit -m "Actualizacion FlightSpy"
git push origin main
if errorlevel 1 (
  echo.
  echo *** Algo fallo. Revisa el mensaje de arriba. ***
) else (
  echo.
  echo *** Publicado. En 1-2 minutos estara en la web y las apps se actualizaran solas. ***
)
echo.
pause
