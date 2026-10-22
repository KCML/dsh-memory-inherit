@echo off
setlocal
echo ==============================================
echo  dsh-memory-inherit installer
echo ==============================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-local.ps1" %*
set CODE=%ERRORLEVEL%
echo.
if not "%CODE%"=="0" (
  echo Install failed with exit code %CODE%.
  echo If you need a different profile:  install.cmd -Profile other
)
pause
exit /b %CODE%
