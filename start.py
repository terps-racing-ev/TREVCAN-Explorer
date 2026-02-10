#!/usr/bin/env python3
"""
CAN Explorer Launcher
=====================
Simple script to start both backend and frontend servers and open the browser.
Manages all processes and automatically cleans up on exit.

Usage: python start.py
"""

import subprocess
import sys
import os
import time
import webbrowser
import signal
import atexit
import socket
from pathlib import Path

# Global process list for cleanup
processes = []

# Color codes for terminal output
class Colors:
    HEADER = '\033[95m'
    OKBLUE = '\033[94m'
    OKCYAN = '\033[96m'
    OKGREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'
    DIM = '\033[2m'

def print_colored(message, color=Colors.OKGREEN):
    """Print colored message"""
    print(f"{color}{message}{Colors.ENDC}")

def print_banner():
    """Print startup banner"""
    print(f"{Colors.FAIL}{Colors.BOLD}")
    print("  +---------------------------------------+")
    print("  |         CAN Explorer v1.0            |")
    print("  +---------------------------------------+")
    print(f"{Colors.ENDC}")

def cleanup_processes():
    """Kill all spawned processes"""
    global processes
    if processes:
        print_colored("\n  Stopping services...", Colors.DIM)
        for proc_info in processes:
            try:
                proc = proc_info['process']
                if proc.poll() is None:
                    if sys.platform == 'win32':
                        subprocess.run(['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                                     capture_output=True, shell=True)
                    else:
                        proc.terminate()
                        try:
                            proc.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            proc.kill()
            except Exception:
                pass
        processes.clear()
        print_colored("  [OK] Stopped", Colors.DIM)

# Register cleanup function
atexit.register(cleanup_processes)

# Handle Ctrl+C gracefully
def signal_handler(sig, frame):
    """Handle interrupt signal"""
    print_colored("\n\n  Shutting down...", Colors.DIM)
    cleanup_processes()
    sys.exit(0)

signal.signal(signal.SIGINT, signal_handler)
if sys.platform == 'win32':
    signal.signal(signal.SIGBREAK, signal_handler)

def get_local_ip():
    """Get the local IP address"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def detect_can_devices():
    """Detect available CAN devices"""
    devices = []
    
    # Check for PCAN
    try:
        from drivers.PCAN_Driver import PCANDriver
        # PCAN is available if import succeeds
        devices.append(("PCAN-USB", "Available"))
    except ImportError:
        devices.append(("PCAN-USB", "Driver not installed"))
    except Exception:
        devices.append(("PCAN-USB", "Not detected"))
    
    # Check for CANable
    try:
        from drivers.CANable_Driver import CANableDriver
        # Check if gs_usb device is present
        try:
            import usb.core
            dev = usb.core.find(idVendor=0x1D50, idProduct=0x606F)
            if dev:
                devices.append(("CANable", "Connected"))
            else:
                devices.append(("CANable", "Not connected"))
        except Exception:
            devices.append(("CANable", "Driver available"))
    except ImportError:
        devices.append(("CANable", "Driver not installed"))
    
    return devices

def check_node_installed():
    """Check if Node.js is installed"""
    # First try using PATH
    try:
        result = subprocess.run(['node', '--version'], 
                              capture_output=True, text=True, shell=True)
        if result.returncode == 0:
            return True, result.stdout.strip()
    except FileNotFoundError:
        pass
    
    # Check common installation paths on Windows
    if sys.platform == 'win32':
        common_paths = [
            Path(os.environ.get('PROGRAMFILES', '')) / 'nodejs' / 'node.exe',
            Path(os.environ.get('PROGRAMFILES(X86)', '')) / 'nodejs' / 'node.exe',
            Path(os.environ.get('LOCALAPPDATA', '')) / 'Programs' / 'node' / 'node.exe',
            Path(os.environ.get('APPDATA', '')) / 'nvm' / 'current' / 'node.exe',  # nvm-windows
        ]
        
        for node_path in common_paths:
            if node_path.exists():
                # Add to PATH for this session
                node_dir = str(node_path.parent)
                os.environ['PATH'] = node_dir + os.pathsep + os.environ.get('PATH', '')
                try:
                    result = subprocess.run([str(node_path), '--version'], 
                                          capture_output=True, text=True)
                    if result.returncode == 0:
                        return True, result.stdout.strip()
                except Exception:
                    pass
    
    return False, None

def check_npm_installed():
    """Check if npm is installed"""
    try:
        result = subprocess.run(['npm', '--version'], 
                              capture_output=True, text=True, shell=True)
        return result.returncode == 0
    except FileNotFoundError:
        return False

def install_frontend_dependencies():
    """Install frontend dependencies if needed"""
    frontend_dir = Path(__file__).parent / "webserver" / "frontend"
    node_modules = frontend_dir / "node_modules"
    
    if not node_modules.exists():
        print_colored("  Installing dependencies...", Colors.DIM)
        try:
            subprocess.run(['npm', 'install'], 
                         cwd=str(frontend_dir), shell=True, check=True, capture_output=True)
            return True
        except subprocess.CalledProcessError:
            return False
    return True

def start_backend():
    """Start the backend server in background"""
    global processes
    backend_dir = Path(__file__).parent / "webserver" / "backend"
    
    # Start backend - use DEVNULL but avoid CREATE_NO_WINDOW which can break asyncio
    if sys.platform == 'win32':
        backend_process = subprocess.Popen(
            [sys.executable, '-u', 'api.py'],
            cwd=str(backend_dir),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
        )
    else:
        backend_process = subprocess.Popen(
            [sys.executable, '-u', 'api.py'],
            cwd=str(backend_dir),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
    
    processes.append({'process': backend_process, 'name': 'Backend'})
    return backend_process

def start_frontend():
    """Start the frontend development server in background"""
    global processes
    frontend_dir = Path(__file__).parent / "webserver" / "frontend"
    
    env = os.environ.copy()
    env['PORT'] = '3001'
    env['BROWSER'] = 'none'
    
    # Start frontend - use DEVNULL
    if sys.platform == 'win32':
        frontend_process = subprocess.Popen(
            ['npm.cmd', 'start'],
            cwd=str(frontend_dir),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
        )
    else:
        frontend_process = subprocess.Popen(
            ['npm', 'start'],
            cwd=str(frontend_dir),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
    
    processes.append({'process': frontend_process, 'name': 'Frontend'})
    return frontend_process

def open_browser(url, delay=5):
    """Open browser after a delay"""
    time.sleep(delay)
    webbrowser.open(url)

def main():
    """Main function"""
    print_banner()
    
    # Get system info
    local_ip = get_local_ip()
    devices = detect_can_devices()
    node_ok, node_version = check_node_installed()
    
    # Check prerequisites
    if not node_ok:
        print_colored("  [X] Node.js not installed", Colors.FAIL)
        print_colored("    Install from: https://nodejs.org/", Colors.DIM)
        sys.exit(1)
    
    if not check_npm_installed():
        print_colored("  [X] npm not installed", Colors.FAIL)
        sys.exit(1)
    
    if not install_frontend_dependencies():
        print_colored("  [X] Failed to install dependencies", Colors.FAIL)
        sys.exit(1)
    
    # Start servers silently
    start_backend()
    time.sleep(2)
    start_frontend()
    
    # Wait for frontend to be ready
    print_colored("\n  Starting services...", Colors.DIM)
    time.sleep(6)
    
    # Open browser
    webbrowser.open("http://localhost:3001")
    
    # Print startup info
    print(f"\n  {Colors.OKGREEN}[OK]{Colors.ENDC} Backend    {Colors.DIM}http://localhost:8000{Colors.ENDC}")
    print(f"  {Colors.OKGREEN}[OK]{Colors.ENDC} Frontend   {Colors.DIM}http://localhost:3001{Colors.ENDC}")
    print(f"  {Colors.OKGREEN}[OK]{Colors.ENDC} Network    {Colors.DIM}http://{local_ip}:3001{Colors.ENDC}")
    
    print(f"\n  {Colors.BOLD}Devices:{Colors.ENDC}")
    for device, status in devices:
        if status in ["Available", "Connected", "Driver available"]:
            color = Colors.OKGREEN
            symbol = "[OK]"
        elif status == "Not connected":
            color = Colors.WARNING
            symbol = "[--]"
        else:
            color = Colors.DIM
            symbol = "[--]"
        print(f"  {color}{symbol}{Colors.ENDC} {device:12} {Colors.DIM}{status}{Colors.ENDC}")
    
    print(f"\n  {Colors.DIM}Press Ctrl+C to stop{Colors.ENDC}\n")
    
    # Keep alive and monitor
    try:
        while True:
            for proc_info in processes:
                if proc_info['process'].poll() is not None:
                    print_colored(f"\n  [X] {proc_info['name']} stopped unexpectedly", Colors.FAIL)
                    cleanup_processes()
                    sys.exit(1)
            time.sleep(2)
    except KeyboardInterrupt:
        cleanup_processes()

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        cleanup_processes()
        sys.exit(0)
