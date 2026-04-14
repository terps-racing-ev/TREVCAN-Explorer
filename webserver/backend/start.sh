#!/bin/bash
# Backend Startup Script for Linux/Mac
# Run this to start the CAN backend server

echo "============================================"
echo "CAN Communication Backend Server"
echo "============================================"

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python 3 is not installed"
    exit 1
fi

# Check if virtual environment exists
if [ -d "venv" ]; then
    echo "Activating virtual environment..."
    source venv/bin/activate
else
    echo "Virtual environment not found. Creating one..."
    python3 -m venv venv
    source venv/bin/activate
    echo "Installing dependencies..."
    pip install -r ../../requirements.txt
fi

# Start the backend server
echo ""
echo "Starting backend server..."
echo "API will be available at: http://localhost:8000"
echo "Documentation: http://localhost:8000/docs"
echo "WebSocket: ws://localhost:8000/ws/can"
echo ""
echo "Press Ctrl+C to stop the server"
echo "============================================"
echo ""

python3 api.py
