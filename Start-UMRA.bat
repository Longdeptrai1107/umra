@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\cli.js" (
  echo Dependencies are missing. Run scripts\setup.bat first.
  pause
  exit /b 1
)
if not exist "dist\desktop\main.cjs" (
  echo App is not built. Run scripts\build.bat first.
  pause
  exit /b 1
)
call node_modules\.bin\electron.cmd .
