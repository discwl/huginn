@echo off
REM Claude Code runs hook commands through POSIX sh on Windows, which cannot
REM execute a .ps1 directly. sh can exec this .cmd, and stdin/stdout pass
REM straight through to the PowerShell hook.
REM
REM Exit code 0 is forced: a non-zero exit from a Claude hook is treated as a
REM turn failure, and advisory graph context is never worth failing a turn.
pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0claude-hook.ps1" %*
exit /b 0
