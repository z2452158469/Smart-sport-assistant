@echo off
setlocal
set "PYTHONUTF8=1"
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" (
  "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" "%~dp0serve.py"
) else (
  python "%~dp0serve.py"
)
pause
