@echo off
title Tone Coach
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\serve.ps1"
if errorlevel 1 pause
