@echo off
setlocal
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Test Node.js runtime not found. The portable final kit is not ready yet.
  exit /b 1
)
node.exe "%~dp0run-browser-comparison.cjs" %*
set "comparison_exit=%errorlevel%"
echo.
echo Exit code: %comparison_exit%
exit /b %comparison_exit%
