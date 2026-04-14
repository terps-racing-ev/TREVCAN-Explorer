#!/bin/bash
# Frontend Startup Script for Linux/Mac

echo "============================================"
echo "CAN Explorer Web Frontend"
echo "============================================"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed"
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Start the development server
echo ""
echo "Starting development server..."
echo "Frontend will be available at: http://localhost:3000"
echo "Backend API should be running at: http://localhost:8000"
echo ""
echo "Press Ctrl+C to stop the server"
echo "============================================"
echo ""

npm start
