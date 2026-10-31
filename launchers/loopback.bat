@echo off
rem Launchpad music effects board - system audio loopback mode (works with headphones)
chcp 65001 >nul
title Launchpad Effects - Loopback
cd /d "%~dp0.."
set PYTHONIOENCODING=utf-8
".venv\Scripts\python.exe" -W ignore app\visualizer.py --source loop --seconds 14400 %*
echo.
echo Exited. Press any key to close.
pause >nul
