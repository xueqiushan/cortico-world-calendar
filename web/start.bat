@echo off
title Shared Calendar - Local Service
cd /d "%~dp0"

echo.
echo   ==========================================
echo    Shared Calendar - local service
echo   ==========================================
echo.
echo   NOTE: Keep this window open.
echo         Closing it stops the calendar.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] node.exe not found in PATH.
  echo.
  echo   Fix: install Node.js LTS from https://nodejs.org
  echo        then close and re-run this file.
  echo.
  pause
  exit /b 1
)

echo   node version:
node -v
echo.
echo   Starting server at http://127.0.0.1:8787/
echo   If an error appears below, that is the reason.
echo   ==========================================
echo.

node server.mjs

echo.
echo   ==========================================
echo   [STOPPED] exit code = %errorlevel%
echo   Read the message above to see why.
echo   ==========================================
echo.
pause
