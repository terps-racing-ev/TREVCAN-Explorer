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
import argparse
import webbrowser
import signal
import atexit
import socket
import urllib.request
import urllib.error
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
    """Gracefully stop all spawned processes, then force-kill if needed."""
    global processes
    if processes:
        print_colored("\n  Stopping services...", Colors.DIM)

        # Ask backend to release CAN hardware first
        try:
            req = urllib.request.Request(
                'http://127.0.0.1:8000/shutdown',
                data=b'{}',
                headers={'Content-Type': 'application/json'},
                method='POST'
            )
            with urllib.request.urlopen(req, timeout=2):
                pass
            print_colored("  [OK] Backend cleanup requested", Colors.DIM)
        except Exception:
            pass

        for proc_info in processes:
            try:
                proc = proc_info['process']
                if proc.poll() is None:
                    if sys.platform == 'win32':
                        try:
                            proc.send_signal(signal.CTRL_BREAK_EVENT)
                        except Exception:
                            pass

                        try:
                            proc.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            subprocess.run(
                                ['taskkill', '/T', '/PID', str(proc.pid)],
                                capture_output=True,
                                shell=True
                            )
                            try:
                                proc.wait(timeout=2)
                            except subprocess.TimeoutExpired:
                                subprocess.run(
                                    ['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                                    capture_output=True,
                                    shell=True
                                )
                    else:
                        proc.terminate()
                        try:
                            proc.wait(timeout=5)
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
    # shell=True is needed on Windows for .cmd wrappers but breaks Linux
    # (list args are silently dropped, causing node REPL to hang)
    _shell = sys.platform == 'win32'
    try:
        result = subprocess.run(['node', '--version'], 
                              capture_output=True, text=True, shell=_shell)
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
    _shell = sys.platform == 'win32'
    try:
        result = subprocess.run(['npm', '--version'], 
                              capture_output=True, text=True, shell=_shell)
        return result.returncode == 0
    except FileNotFoundError:
        return False

def install_frontend_dependencies():
    """Install frontend dependencies if needed"""
    frontend_dir = Path(__file__).parent / "webserver" / "frontend"
    node_modules = frontend_dir / "node_modules"
    
    if not node_modules.exists():
        print_colored("  Installing dependencies...", Colors.DIM)
        _shell = sys.platform == 'win32'
        try:
            subprocess.run(['npm', 'install'], 
                         cwd=str(frontend_dir), shell=_shell, check=True, capture_output=True)
            return True
        except subprocess.CalledProcessError:
            return False
    return True

def is_port_open(host, port, timeout=0.5):
    """Check if a TCP port is currently in use."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False

def request_backend_shutdown():
    """Ask any existing backend instance to shut down gracefully."""
    try:
        req = urllib.request.Request(
            'http://127.0.0.1:8000/shutdown',
            data=b'{}',
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        with urllib.request.urlopen(req, timeout=2):
            pass
        return True
    except Exception:
        return False

def _kill_port_owner_windows(port):
    """Force-kill process(es) listening on a TCP port (Windows)."""
    try:
        result = subprocess.run(
            ['netstat', '-ano', '-p', 'tcp'],
            capture_output=True,
            text=True,
            shell=True
        )
        if result.returncode != 0:
            return False

        pids = set()
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) < 5:
                continue

            local_addr = parts[1]
            state = parts[3]
            pid = parts[4]

            if state.upper() != 'LISTENING':
                continue
            if not local_addr.endswith(f':{port}'):
                continue
            if pid.isdigit():
                pids.add(pid)

        killed_any = False
        for pid in pids:
            subprocess.run(
                ['taskkill', '/F', '/T', '/PID', pid],
                capture_output=True,
                shell=True
            )
            killed_any = True

        return killed_any
    except Exception:
        return False

def ensure_clean_ports():
    """Prevent stale services from running an outdated API surface."""
    stale_backend = is_port_open('127.0.0.1', 8000)
    stale_frontend = is_port_open('127.0.0.1', 3001)

    if stale_backend:
        print_colored("  Found existing backend on :8000, requesting shutdown...", Colors.DIM)
        request_backend_shutdown()
        time.sleep(1.0)

    if sys.platform == 'win32':
        if is_port_open('127.0.0.1', 8000):
            print_colored("  Replacing stale backend on :8000...", Colors.WARNING)
            _kill_port_owner_windows(8000)
            time.sleep(0.8)

        if stale_frontend and is_port_open('127.0.0.1', 3001):
            print_colored("  Replacing stale frontend on :3001...", Colors.WARNING)
            _kill_port_owner_windows(3001)
            time.sleep(0.8)

def start_backend(inherit_logs=False):
    """Start the backend server in background"""
    global processes
    backend_dir = Path(__file__).parent / "webserver" / "backend"
    stdout_target = None if inherit_logs else subprocess.DEVNULL
    stderr_target = None if inherit_logs else subprocess.DEVNULL
    
    # Start backend - use DEVNULL but avoid CREATE_NO_WINDOW which can break asyncio
    if sys.platform == 'win32':
        backend_process = subprocess.Popen(
            [sys.executable, '-u', 'api.py'],
            cwd=str(backend_dir),
            stdout=stdout_target,
            stderr=stderr_target,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
        )
    else:
        backend_process = subprocess.Popen(
            [sys.executable, '-u', 'api.py'],
            cwd=str(backend_dir),
            stdout=stdout_target,
            stderr=stderr_target
        )
    
    processes.append({'process': backend_process, 'name': 'Backend'})
    return backend_process

def start_frontend(inherit_logs=False):
    """Start the frontend development server in background"""
    global processes
    frontend_dir = Path(__file__).parent / "webserver" / "frontend"
    stdout_target = None if inherit_logs else subprocess.DEVNULL
    stderr_target = None if inherit_logs else subprocess.DEVNULL
    
    env = os.environ.copy()
    env['PORT'] = '3001'
    env['BROWSER'] = 'none'
    
    # Start frontend - use DEVNULL
    if sys.platform == 'win32':
        frontend_process = subprocess.Popen(
            ['npm.cmd', 'start'],
            cwd=str(frontend_dir),
            env=env,
            stdout=stdout_target,
            stderr=stderr_target,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
        )
    else:
        frontend_process = subprocess.Popen(
            ['npm', 'start'],
            cwd=str(frontend_dir),
            env=env,
            stdout=stdout_target,
            stderr=stderr_target
        )
    
    processes.append({'process': frontend_process, 'name': 'Frontend'})
    return frontend_process

def open_browser(url, delay=5):
    """Open browser after a delay"""
    time.sleep(delay)
    webbrowser.open(url)

def parse_args():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(description="Start the TREVCAN Explorer stack")
    parser.add_argument(
        '--no-browser',
        action='store_true',
        help='Do not open the frontend URL in a browser'
    )
    parser.add_argument(
        '--inherit-logs',
        action='store_true',
        help='Send backend and frontend logs to the current stdout/stderr'
    )
    parser.add_argument(
        '--service',
        action='store_true',
        help='Enable systemd-friendly behavior (no browser, inherited logs, no device scan)'
    )
    return parser.parse_args()

def main(args):
    """Main function"""
    service_mode = args.service
    show_browser = not args.no_browser and not service_mode
    inherit_logs = args.inherit_logs or service_mode

    if not service_mode:
        print_banner()
    
    # Get system info
    local_ip = get_local_ip()
    devices = detect_can_devices() if not service_mode else []
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
    
    # Ensure stale dev servers from old revisions do not survive across updates.
    ensure_clean_ports()

    # Start servers silently
    start_backend(inherit_logs=inherit_logs)
    time.sleep(2)
    start_frontend(inherit_logs=inherit_logs)
    
    # Wait for frontend to be ready
    print_colored("\n  Starting services...", Colors.DIM)
    time.sleep(6)
    
    # Open browser
    if show_browser:
        webbrowser.open(f"http://{local_ip}:3001")
    
    # Print startup info
    print(f"\n  {Colors.OKGREEN}[OK]{Colors.ENDC} Backend    {Colors.DIM}http://localhost:8000{Colors.ENDC}")
    print(f"  {Colors.OKGREEN}[OK]{Colors.ENDC} Frontend   {Colors.DIM}http://localhost:3001{Colors.ENDC}")
    print(f"  {Colors.OKGREEN}[OK]{Colors.ENDC} Network    {Colors.DIM}http://{local_ip}:3001{Colors.ENDC}")
    
    if devices:
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
        main(parse_args())
    except KeyboardInterrupt:
        cleanup_processes()
        sys.exit(0)
