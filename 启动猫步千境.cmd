@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts\run-local-desktop.mjs
if errorlevel 1 pause
