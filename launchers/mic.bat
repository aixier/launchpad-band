@echo off
rem Launchpad music effects board - microphone mode (ASCII only on purpose: cmd mangles UTF-8 batch files)
chcp 65001 >nul
title Launchpad Effects - Microphone
cd /d "%~dp0.."
set PYTHONIOENCODING=utf-8
".venv\Scripts\python.exe" -W ignore app\visualizer.py --seconds 14400 %*
echo.
echo Exited. Press any key to close.
pause >nul
