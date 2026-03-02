@echo off
REM Backend Startup Script for Windows
REM Run this to start the CAN backend server

echo ============================================
echo CAN Communication Backend Server
echo ============================================

REM Check if Python is installed
python --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Python is not installed or not in PATH
    pause
    exit /b 1
)

REM Check if virtual environment exists
if exist venv (
    echo Activating virtual environment...
    call venv\Scripts\activate
) else (
    echo Virtual environment not found. Creating one...
    python -m venv venv
    call venv\Scripts\activate
    echo Installing dependencies...
    pip install -r ..\..\requirements.txt
)

REM Start the backend server
echo.
echo Starting backend server...
echo API will be available at: http://localhost:8000
echo Documentation: http://localhost:8000/docs
echo WebSocket: ws://localhost:8000/ws/can
echo.
echo Press Ctrl+C to stop the server
echo ============================================
echo.

python api.py

pause
