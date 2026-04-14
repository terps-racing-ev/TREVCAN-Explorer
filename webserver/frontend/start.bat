@echo off
REM Frontend Startup Script for Windows
echo ============================================
echo CAN Explorer Web Frontend
echo ============================================

REM Check if Node.js is installed
node --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js is not installed
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

REM Check if node_modules exists
if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

REM Start the development server
echo.
echo Starting development server...
echo Frontend will be available at: http://localhost:3000
echo Backend API should be running at: http://localhost:8000
echo.
echo Press Ctrl+C to stop the server
echo ============================================
echo.

npm start

pause
