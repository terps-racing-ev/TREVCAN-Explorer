"""
BRemoteZ Bluetooth CAN Driver for Windows
==========================================
Native Windows Bluetooth SPP driver connecting to BRemoteZ-BT-Server.
Uses binary protocol for efficient CAN frame transmission over Bluetooth RFCOMM.

Requirements:
    - Windows 10/11 with Bluetooth
    - Python 3.9+ (native Bluetooth socket support)
    - Device must be paired first via Windows Bluetooth settings
    - BRemoteZ-BT-Server running on target device

Protocol:
    Binary frames with XOR checksum - see BRemoteZ-BT-Server/protocol.py
    - CAN_FRAME (0xAA): CAN message transmission
    - CONTROL_CMD (0xBB): Control commands (start/stop streaming, ping, etc.)
    - RESPONSE (0xCC): Server responses
    - ERROR (0xDD): Error frames

Author: GitHub Copilot
Date: January 2026
"""

import socket
import struct
import time
import threading
from dataclasses import dataclass
from typing import Optional, Callable, List, Dict, Any
from enum import IntEnum
import subprocess
import re

# Check if Bluetooth sockets are available
BLUETOOTH_AVAILABLE = False
try:
    # Test if AF_BLUETOOTH is available (Windows 10/11 with Python 3.9+)
    test_socket = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, 3)
    test_socket.close()
    BLUETOOTH_AVAILABLE = True
except (AttributeError, OSError):
    pass


# =============================================================================
# Protocol Constants (matching BRemoteZ-BT-Server/protocol.py)
# =============================================================================

class FrameHeader(IntEnum):
    """Frame type headers"""
    CAN_FRAME = 0xAA
    CONTROL_CMD = 0xBB
    RESPONSE = 0xCC
    ERROR = 0xDD


class ControlCommand(IntEnum):
    """Control commands to server"""
    START_STREAMING = 0x01
    STOP_STREAMING = 0x02
    GET_STATUS = 0x03
    PING = 0x04
    SET_FILTER = 0x05
    CLEAR_FILTERS = 0x06


class ResponseCode(IntEnum):
    """Response codes from server"""
    OK = 0x00
    ERROR = 0x01
    STREAMING_STARTED = 0x02
    STREAMING_STOPPED = 0x03
    STATUS = 0x04
    PONG = 0x05


class ErrorCode(IntEnum):
    """Error codes from server"""
    UNKNOWN_COMMAND = 0x01
    CAN_ERROR = 0x02
    INVALID_FRAME = 0x03
    CHECKSUM_ERROR = 0x04
    BUFFER_OVERFLOW = 0x05


# =============================================================================
# Protocol Helper Functions
# =============================================================================

def calculate_checksum(data: bytes) -> int:
    """Calculate XOR checksum"""
    checksum = 0
    for b in data:
        checksum ^= b
    return checksum


def verify_checksum(data: bytes) -> bool:
    """Verify XOR checksum of complete frame (including checksum byte)"""
    return calculate_checksum(data) == 0


def create_control_command(cmd: ControlCommand, payload: bytes = b'') -> bytes:
    """Create a control command frame"""
    frame = struct.pack('>BB', FrameHeader.CONTROL_CMD, cmd) + payload
    checksum = calculate_checksum(frame)
    return frame + bytes([checksum])


def create_can_frame_bytes(can_id: int, data: bytes, is_extended: bool = False, 
                           is_remote: bool = False, timestamp: float = 0.0) -> bytes:
    """
    Serialize CAN frame to bytes for Bluetooth transmission.
    Format: Header(1) | Flags(1) | CAN_ID(4) | DLC(1) | Timestamp(8) | Data(0-8) | Checksum(1)
    """
    flags = 0
    if is_extended:
        flags |= 0x01
    if is_remote:
        flags |= 0x02
    
    # Convert timestamp to microseconds (64-bit unsigned)
    timestamp_us = int(timestamp * 1_000_000) & 0xFFFFFFFFFFFFFFFF
    
    frame = struct.pack(
        '>BBIBQ',
        FrameHeader.CAN_FRAME,
        flags,
        can_id,
        len(data),
        timestamp_us
    ) + data
    
    checksum = calculate_checksum(frame)
    return frame + bytes([checksum])


# =============================================================================
# Data Classes
# =============================================================================

@dataclass
class CANMessage:
    """CAN message structure matching the main driver interface."""
    id: int
    data: bytes
    timestamp: float = 0.0
    is_extended: bool = False
    is_remote: bool = False
    dlc: int = 0
    channel: str = "bluetooth"
    server_decoded: Optional[Dict[str, Any]] = None  # For future DBC decoding on server
    
    def __post_init__(self):
        if self.dlc == 0:
            self.dlc = len(self.data)


@dataclass
class ServerStatus:
    """Server status information from GET_STATUS response"""
    streaming: bool
    can_connected: bool
    uptime: int
    can_rx_count: int
    can_tx_count: int
    bt_rx_count: int
    bt_tx_count: int
    errors: int


# =============================================================================
# Windows Bluetooth Device Discovery
# =============================================================================

def get_paired_bluetooth_devices() -> List[Dict[str, str]]:
    """
    Get list of paired Bluetooth devices from Windows.
    Uses PowerShell to query the registry for paired devices.
    
    Returns:
        List of dicts with 'name' and 'address' keys
    """
    devices = []
    
    try:
        # PowerShell command to get paired Bluetooth devices
        ps_cmd = '''
        Get-ChildItem -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices" -ErrorAction SilentlyContinue | ForEach-Object {
            $addr = $_.PSChildName
            $name = (Get-ItemProperty -Path $_.PSPath -Name "Name" -ErrorAction SilentlyContinue).Name
            if ($name) {
                # Convert name from byte array to string
                $nameStr = [System.Text.Encoding]::UTF8.GetString($name).TrimEnd([char]0)
                # Format address with colons
                $formattedAddr = ($addr -replace '(.{2})', '$1:').TrimEnd(':')
                Write-Output "$formattedAddr|$nameStr"
            }
        }
        '''
        
        result = subprocess.run(
            ["powershell", "-Command", ps_cmd],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        for line in result.stdout.strip().split('\n'):
            if '|' in line:
                addr, name = line.strip().split('|', 1)
                if addr and name:
                    devices.append({
                        'address': addr.upper(),
                        'name': name
                    })
                    
    except Exception as e:
        print(f"[Bluetooth] Error getting paired devices: {e}")
    
    return devices


# =============================================================================
# Main Driver Class
# =============================================================================

class BluetoothCANDriver:
    """
    Bluetooth CAN driver connecting to BRemoteZ-BT-Server.
    Uses binary protocol over RFCOMM for efficient CAN frame transmission.
    """
    
    # Bluetooth RFCOMM protocol number
    BTPROTO_RFCOMM = 3
    
    def __init__(self):
        self._socket: Optional[socket.socket] = None
        self._connected = False
        self._streaming = False
        self._receive_thread: Optional[threading.Thread] = None
        self._stop_receive = False
        self._message_callback: Optional[Callable[[CANMessage], None]] = None
        self._receive_buffer = bytearray()
        self._response_queue: List[tuple] = []  # (response_code, payload)
        self._response_lock = threading.Lock()
        self._response_event = threading.Event()
        self._address = ""
        self._channel = 1
        self._last_status: Optional[ServerStatus] = None
        
        # Statistics
        self._stats = {
            'tx_count': 0,
            'rx_count': 0,
            'errors': 0
        }
    
    @property
    def is_connected(self) -> bool:
        return self._connected
    
    @property
    def is_streaming(self) -> bool:
        return self._streaming
    
    @staticmethod
    def list_devices() -> List[Dict[str, str]]:
        """Get list of paired Bluetooth devices."""
        return get_paired_bluetooth_devices()
    
    def connect(self, address: str, channel: int = 1, timeout: float = 10.0) -> bool:
        """
        Connect to BRemoteZ-BT-Server.
        
        Args:
            address: Bluetooth MAC address (XX:XX:XX:XX:XX:XX)
            channel: RFCOMM channel (default 1)
            timeout: Connection timeout in seconds
            
        Returns:
            True if connected successfully
        """
        if self._connected:
            print("[Bluetooth] Already connected")
            return True
        
        if not BLUETOOTH_AVAILABLE:
            print("[Bluetooth] Native Bluetooth sockets not available")
            print("[Bluetooth] Requires Windows 10/11 with Python 3.9+")
            return False
        
        # Validate and normalize address format
        address = address.strip().upper()
        if not re.match(r'^([0-9A-F]{2}:){5}[0-9A-F]{2}$', address):
            print(f"[Bluetooth] Invalid address format: {address}")
            print("[Bluetooth] Expected format: XX:XX:XX:XX:XX:XX")
            return False
        
        self._address = address
        self._channel = channel
        
        try:
            print(f"[Bluetooth] Connecting to BRemoteZ server at {address} channel {channel}...")
            
            # Create Bluetooth RFCOMM socket
            self._socket = socket.socket(
                socket.AF_BLUETOOTH,
                socket.SOCK_STREAM,
                self.BTPROTO_RFCOMM
            )
            self._socket.settimeout(timeout)
            self._socket.connect((address, channel))
            
            self._connected = True
            self._stop_receive = False
            self._receive_buffer.clear()
            
            # Start receive thread
            self._receive_thread = threading.Thread(
                target=self._receive_loop,
                daemon=True,
                name="BRemoteZ-Receive"
            )
            self._receive_thread.start()
            
            # Verify connection with PING
            print("[Bluetooth] Verifying connection...")
            if self._send_ping():
                print(f"[Bluetooth] Connected to BRemoteZ server at {address}")
                return True
            else:
                print("[Bluetooth] Warning: Server did not respond to PING, but connection established")
                return True
                
        except OSError as e:
            error_msgs = {
                10061: "Connection refused - is BRemoteZ server running?",
                10060: "Connection timed out - is device in range and paired?",
                10050: "Bluetooth adapter not available",
                10051: "Network unreachable - check Bluetooth is enabled",
            }
            msg = error_msgs.get(e.errno, str(e))
            print(f"[Bluetooth] Connection failed: {msg}")
            self._cleanup_socket()
            return False
        except Exception as e:
            print(f"[Bluetooth] Connection failed: {e}")
            self._cleanup_socket()
            return False
    
    def _cleanup_socket(self):
        """Clean up socket on error"""
        if self._socket:
            try:
                self._socket.close()
            except:
                pass
        self._socket = None
        self._connected = False
    
    def disconnect(self) -> bool:
        """Disconnect from server."""
        if not self._connected:
            return True
        
        print("[Bluetooth] Disconnecting from BRemoteZ server...")
        
        # Stop streaming first
        if self._streaming:
            try:
                self._stop_streaming()
            except:
                pass
        
        self._stop_receive = True
        self._connected = False
        self._streaming = False
        
        if self._socket:
            try:
                self._socket.close()
            except:
                pass
            self._socket = None
        
        if self._receive_thread and self._receive_thread.is_alive():
            self._receive_thread.join(timeout=2.0)
        
        print("[Bluetooth] Disconnected")
        return True
    
    def stop_receive_thread(self) -> bool:
        """
        Stop the background receive thread.
        Required for API compatibility with other drivers.
        """
        if not self._receive_thread or not self._receive_thread.is_alive():
            return False
        
        # Stop streaming if active
        if self._streaming:
            self._stop_streaming()
        
        self._stop_receive = True
        self._receive_thread.join(timeout=2.0)
        
        if self._receive_thread.is_alive():
            print("[Bluetooth] Warning: Receive thread did not stop cleanly")
            return False
        
        self._receive_thread = None
        self._message_callback = None
        print("[Bluetooth] Receive thread stopped")
        return True
    
    def __del__(self):
        """Destructor to ensure cleanup on garbage collection."""
        try:
            if self._connected:
                self.disconnect()
        except:
            pass
    
    # =========================================================================
    # Receive Loop and Frame Parsing
    # =========================================================================
    
    def _receive_loop(self):
        """Background thread to receive data from server."""
        while not self._stop_receive and self._connected:
            try:
                self._socket.settimeout(0.5)
                data = self._socket.recv(4096)
                
                if not data:
                    break
                
                self._receive_buffer.extend(data)
                self._process_receive_buffer()
                        
            except socket.timeout:
                continue
            except Exception as e:
                if not self._stop_receive:
                    self._stats['errors'] += 1
                break
        
        if self._connected:
            self._connected = False
            self._streaming = False
    
    def _process_receive_buffer(self):
        """Process complete frames from receive buffer."""
        while len(self._receive_buffer) >= 3:
            frame_type = self._receive_buffer[0]
            
            if frame_type == FrameHeader.CAN_FRAME:
                # CAN frame: header(1) + flags(1) + id(4) + dlc(1) + timestamp(8) + data(0-8) + checksum(1)
                if len(self._receive_buffer) < 16:
                    break
                dlc = self._receive_buffer[6]
                if dlc > 8:
                    # Invalid DLC, skip byte
                    self._receive_buffer = self._receive_buffer[1:]
                    continue
                frame_len = 16 + dlc
                if len(self._receive_buffer) < frame_len:
                    break
                
                frame_data = bytes(self._receive_buffer[:frame_len])
                self._receive_buffer = self._receive_buffer[frame_len:]
                
                self._handle_can_frame(frame_data)
            
            elif frame_type == FrameHeader.RESPONSE:
                # Response: header(1) + code(1) + payload + checksum(1)
                # Minimum 3 bytes, may have variable payload
                # For now, try to parse assuming short responses
                frame_len = self._find_response_frame_length()
                if frame_len is None:
                    break
                
                frame_data = bytes(self._receive_buffer[:frame_len])
                self._receive_buffer = self._receive_buffer[frame_len:]
                
                self._handle_response(frame_data)
            
            elif frame_type == FrameHeader.ERROR:
                # Error: header(1) + code(1) + msg_len(1) + msg + checksum(1)
                if len(self._receive_buffer) < 4:
                    break
                msg_len = self._receive_buffer[2]
                frame_len = 4 + msg_len
                if len(self._receive_buffer) < frame_len:
                    break
                
                frame_data = bytes(self._receive_buffer[:frame_len])
                self._receive_buffer = self._receive_buffer[frame_len:]
                
                self._handle_error(frame_data)
            
            else:
                # Unknown frame type, skip byte
                print(f"[Bluetooth] Unknown frame type: 0x{frame_type:02X}")
                self._receive_buffer = self._receive_buffer[1:]
    
    def _find_response_frame_length(self) -> Optional[int]:
        """
        Determine response frame length based on response code.
        Returns None if not enough data.
        """
        if len(self._receive_buffer) < 3:
            return None
        
        code = self._receive_buffer[1]
        
        # Fixed-length responses
        if code in (ResponseCode.OK, ResponseCode.PONG, 
                    ResponseCode.STREAMING_STARTED, ResponseCode.STREAMING_STOPPED):
            return 3  # header + code + checksum
        
        elif code == ResponseCode.STATUS:
            # Status: header(1) + code(1) + payload(22) + checksum(1) = 25 bytes
            # payload: streaming(1) + can_connected(1) + uptime(4) + can_rx(4) + can_tx(4) + bt_rx(4) + bt_tx(4) + errors(4) = 22
            return 25
        
        elif code == ResponseCode.ERROR:
            return 3  # Simple error response
        
        else:
            # Unknown response, assume minimal
            return 3
    
    def _handle_can_frame(self, data: bytes):
        """Handle received CAN frame."""
        if not verify_checksum(data):
            self._stats['errors'] += 1
            return
        
        # Parse: header(1) + flags(1) + id(4) + dlc(1) + timestamp(8) + data(0-8)
        flags = data[1]
        can_id = struct.unpack('>I', data[2:6])[0]
        dlc = data[6]
        timestamp_us = struct.unpack('>Q', data[7:15])[0]
        can_data = data[15:15+dlc]
        
        msg = CANMessage(
            id=can_id,
            data=bytes(can_data),
            timestamp=timestamp_us / 1_000_000.0,
            is_extended=bool(flags & 0x01),
            is_remote=bool(flags & 0x02),
            dlc=dlc,
            channel="bluetooth"
        )
        
        self._stats['rx_count'] += 1
        
        if self._message_callback:
            try:
                self._message_callback(msg)
            except Exception as e:
                pass
    
    def _handle_response(self, data: bytes):
        """Handle received response frame."""
        if not verify_checksum(data):
            print("[Bluetooth] Response checksum error")
            self._stats['errors'] += 1
            return
        
        code = data[1]
        payload = data[2:-1] if len(data) > 3 else b''
        
        # Queue response for waiting commands
        with self._response_lock:
            self._response_queue.append((code, payload))
            self._response_event.set()
    
    def _handle_error(self, data: bytes):
        """Handle received error frame."""
        if not verify_checksum(data):
            return
        
        code = data[1]
        msg_len = data[2]
        msg = data[3:3+msg_len].decode('utf-8', errors='ignore') if msg_len > 0 else ''
        
        error_names = {
            ErrorCode.UNKNOWN_COMMAND: "Unknown command",
            ErrorCode.CAN_ERROR: "CAN error",
            ErrorCode.INVALID_FRAME: "Invalid frame",
            ErrorCode.CHECKSUM_ERROR: "Checksum error",
            ErrorCode.BUFFER_OVERFLOW: "Buffer overflow"
        }
        error_name = error_names.get(code, f"Error 0x{code:02X}")
        print(f"[Bluetooth] Server error: {error_name}" + (f" - {msg}" if msg else ""))
        self._stats['errors'] += 1
    
    # =========================================================================
    # Command Methods
    # =========================================================================
    
    def _send_raw(self, data: bytes) -> bool:
        """Send raw bytes to server."""
        if not self._connected or not self._socket:
            return False
        try:
            self._socket.send(data)
            return True
        except Exception as e:
            print(f"[Bluetooth] Send error: {e}")
            self._stats['errors'] += 1
            return False
    
    def _wait_for_response(self, timeout: float = 2.0) -> Optional[tuple]:
        """Wait for a response from server."""
        self._response_event.clear()
        
        start = time.time()
        while time.time() - start < timeout:
            with self._response_lock:
                if self._response_queue:
                    return self._response_queue.pop(0)
            self._response_event.wait(0.1)
            self._response_event.clear()
        
        return None
    
    def _send_command(self, cmd: ControlCommand, payload: bytes = b'', 
                      timeout: float = 2.0) -> Optional[tuple]:
        """Send control command and wait for response."""
        # Clear any pending responses
        with self._response_lock:
            self._response_queue.clear()
        
        frame = create_control_command(cmd, payload)
        if not self._send_raw(frame):
            return None
        
        return self._wait_for_response(timeout)
    
    def _send_ping(self) -> bool:
        """Send PING command and wait for PONG."""
        response = self._send_command(ControlCommand.PING)
        if response and response[0] == ResponseCode.PONG:
            return True
        return False
    
    def _start_streaming(self) -> bool:
        """Start CAN frame streaming from server."""
        if self._streaming:
            return True
        
        response = self._send_command(ControlCommand.START_STREAMING)
        if response and response[0] == ResponseCode.STREAMING_STARTED:
            self._streaming = True
            print("[Bluetooth] CAN streaming started")
            return True
        
        print("[Bluetooth] Failed to start streaming")
        return False
    
    def _stop_streaming(self) -> bool:
        """Stop CAN frame streaming from server."""
        if not self._streaming:
            return True
        
        response = self._send_command(ControlCommand.STOP_STREAMING)
        if response and response[0] == ResponseCode.STREAMING_STOPPED:
            self._streaming = False
            print("[Bluetooth] CAN streaming stopped")
            return True
        
        # Even if no response, mark as stopped
        self._streaming = False
        return False
    
    # =========================================================================
    # Public API Methods (Compatible with other drivers)
    # =========================================================================
    
    def send_message(self, arbitration_id: int, data: bytes, 
                     is_extended: bool = False, is_remote: bool = False) -> bool:
        """
        Send a CAN message via the server.
        
        Args:
            arbitration_id: CAN message ID
            data: Message data bytes (max 8 bytes)
            is_extended: Extended ID flag
            is_remote: Remote frame flag
            
        Returns:
            True if sent successfully
        """
        if not self._connected:
            return False
        
        # Ensure data is not longer than 8 bytes
        if len(data) > 8:
            data = data[:8]
        
        frame = create_can_frame_bytes(
            can_id=arbitration_id,
            data=data,
            is_extended=is_extended,
            is_remote=is_remote,
            timestamp=time.time()
        )
        
        if self._send_raw(frame):
            self._stats['tx_count'] += 1
            return True
        return False
    
    def start_receive_thread(self, callback: Callable[[CANMessage], None]) -> bool:
        """
        Start receiving messages with callback.
        This sets the callback and starts CAN streaming from server.
        """
        self._message_callback = callback
        
        if self._connected:
            # Start streaming CAN frames from server
            return self._start_streaming()
        
        return False
    
    def get_status(self) -> Optional[ServerStatus]:
        """
        Get server status.
        
        Returns:
            ServerStatus object or None on failure
        """
        response = self._send_command(ControlCommand.GET_STATUS)
        if response and response[0] == ResponseCode.STATUS:
            payload = response[1]
            if len(payload) >= 22:
                streaming, can_connected, uptime, can_rx, can_tx, bt_rx, bt_tx, errors = \
                    struct.unpack('>BBIIIIII', payload[:22])
                
                self._last_status = ServerStatus(
                    streaming=bool(streaming),
                    can_connected=bool(can_connected),
                    uptime=uptime,
                    can_rx_count=can_rx,
                    can_tx_count=can_tx,
                    bt_rx_count=bt_rx,
                    bt_tx_count=bt_tx,
                    errors=errors
                )
                return self._last_status
        
        return None
    
    def get_bus_status(self) -> dict:
        """
        Get the current status of the Bluetooth CAN connection.
        Required for API compatibility with other drivers.
        
        Returns:
            Dictionary containing connection status information.
        """
        if not self._connected:
            return {'connected': False, 'error': 'Not connected'}
        
        status = {
            'connected': True,
            'channel': f'bluetooth:{self._address}',
            'address': self._address,
            'rfcomm_channel': self._channel,
            'streaming': self._streaming,
            'status': 'OK',
            'local_stats': self._stats.copy()
        }
        
        # Try to get server status
        try:
            server_status = self.get_status()
            if server_status:
                status['server_status'] = {
                    'streaming': server_status.streaming,
                    'can_connected': server_status.can_connected,
                    'uptime': server_status.uptime,
                    'can_rx_count': server_status.can_rx_count,
                    'can_tx_count': server_status.can_tx_count,
                    'bt_rx_count': server_status.bt_rx_count,
                    'bt_tx_count': server_status.bt_tx_count,
                    'errors': server_status.errors
                }
        except Exception as e:
            status['server_status_error'] = str(e)
        
        return status
    
    def set_filter(self, can_id: int, can_mask: int = 0xFFFFFFFF) -> bool:
        """
        Set a CAN filter on the server.
        
        Args:
            can_id: CAN ID to filter
            can_mask: Mask for the filter (default: exact match)
            
        Returns:
            True if filter set successfully
        """
        payload = struct.pack('>II', can_id, can_mask)
        response = self._send_command(ControlCommand.SET_FILTER, payload)
        return response is not None and response[0] == ResponseCode.OK
    
    def clear_filters(self) -> bool:
        """
        Clear all CAN filters on the server.
        
        Returns:
            True if filters cleared successfully
        """
        response = self._send_command(ControlCommand.CLEAR_FILTERS)
        return response is not None and response[0] == ResponseCode.OK
    
    def ping(self) -> bool:
        """
        Send PING to server to verify connection.
        
        Returns:
            True if PONG received
        """
        return self._send_ping()
    
    # =========================================================================
    # Legacy API Methods (for compatibility)
    # =========================================================================
    
    def upload_dbc(self, dbc_path: str) -> bool:
        """
        Upload DBC file to server (not supported in BRemoteZ protocol).
        BRemoteZ uses raw CAN frames without server-side DBC decoding.
        DBC decoding should be done client-side.
        
        Returns:
            False (not supported)
        """
        print("[Bluetooth] Note: BRemoteZ server does not support DBC upload")
        print("[Bluetooth] DBC decoding should be done client-side")
        return False
    
    def unload_dbc(self) -> bool:
        """Not supported in BRemoteZ protocol."""
        return False
    
    def clear_messages(self) -> bool:
        """Not supported in BRemoteZ protocol (no server-side buffering)."""
        return False
    
    def get_messages(self, count: int = 100) -> dict:
        """Not supported in BRemoteZ protocol (streaming only)."""
        return {"success": False, "error": "Not supported - use streaming instead"}
    
    def send_batch(self, messages: list) -> bool:
        """
        Send multiple CAN messages.
        
        Args:
            messages: List of dicts with 'id', 'data', optional 'extended', 'remote'
            
        Returns:
            True if all messages sent successfully
        """
        if not self._connected:
            return False
        
        success = True
        for msg in messages:
            can_id = msg.get('id', 0)
            data = msg.get('data', [])
            if isinstance(data, list):
                data = bytes(data)
            is_extended = msg.get('extended', False)
            is_remote = msg.get('remote', False)
            
            if not self.send_message(can_id, data, is_extended, is_remote):
                success = False
        
        return success


# =============================================================================
# Module Test
# =============================================================================

if __name__ == "__main__":
    print("BRemoteZ Bluetooth CAN Driver Test")
    print("=" * 50)
    print(f"Bluetooth Available: {BLUETOOTH_AVAILABLE}")
    print()
    
    if BLUETOOTH_AVAILABLE:
        print("Paired Bluetooth devices:")
        devices = get_paired_bluetooth_devices()
        if devices:
            for i, dev in enumerate(devices):
                print(f"  {i+1}. {dev['name']} ({dev['address']})")
        else:
            print("  No paired devices found")
        
        print()
        print("To test connection:")
        print("  driver = BluetoothCANDriver()")
        print("  driver.connect('XX:XX:XX:XX:XX:XX')")
        print("  driver.start_receive_thread(lambda msg: print(msg))")
    else:
        print("Bluetooth not available.")
        print("Requirements:")
        print("  - Windows 10/11")
        print("  - Python 3.9 or newer")
        print("  - Bluetooth adapter enabled")
