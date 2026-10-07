@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0.deps\sklearn" (
  if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" (
    set "PYTHONPATH=%~dp0.deps"
    "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" train.py %*
    exit /b
  )
)
if exist "%~dp0.venv\Scripts\python.exe" (
  "%~dp0.venv\Scripts\python.exe" train.py %*
) else (
  python train.py %*
)
