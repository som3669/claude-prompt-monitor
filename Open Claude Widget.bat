@echo off
REM Opens the Claude Prompt Monitor desktop widget without VS Code.
REM Double-click this, or copy it to your Desktop / pin it to the taskbar.
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0media\overlay.ps1"
