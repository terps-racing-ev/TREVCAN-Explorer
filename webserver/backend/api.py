"""
CAN Communication Backend API
==============================
FastAPI backend for CAN device communication with WebSocket support.
Provides REST endpoints and real-time WebSocket streams for CAN messages.

Author: GitHub Copilot
Date: October 27, 2025
"""

import sys
import os
from pathlib import Path
from typing import Optional, Dict, List, Union
from datetime import datetime
import asyncio
import json
import random
import time
import math
from enum import Enum
import atexit

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
import uvicorn
import shutil

# Add parent directories to path for driver imports
backend_dir = Path(__file__).parent
project_dir = backend_dir.parent.parent
sys.path.insert(0, str(project_dir))

# DBC files directory setup
DBC_DIR = backend_dir / "dbc_files"
DBC_DIR.mkdir(exist_ok=True)
LAST_DBC_FILE = DBC_DIR / "last_loaded.txt"

# Transmit lists directory setup
TRANSMIT_LISTS_DIR = backend_dir / "transmit_lists"
TRANSMIT_LISTS_DIR.mkdir(exist_ok=True)

# Import CAN drivers
try:
    from drivers.PCAN_Driver import PCANDriver, PCANChannel, PCANBaudRate, CANMessage as PCANMessage
    PCAN_AVAILABLE = True
except ImportError:
    PCAN_AVAILABLE = False
    print("Warning: PCAN_Driver not available")

try:
    from drivers.CANable_Driver import CANableDriver, CANableBaudRate, CANMessage as CANableMessage
    CANABLE_AVAILABLE = True
except ImportError:
    CANABLE_AVAILABLE = False
    print("Warning: CANable_Driver not available")

try:
    from drivers.NetworkCAN_Driver import NetworkCANDriver, NetworkCANBaudRate, CANMessage as NetworkCANMessage
    NETWORK_CAN_AVAILABLE = True
except ImportError:
    NETWORK_CAN_AVAILABLE = False
    print("Warning: NetworkCAN_Driver not available")

try:
    from drivers.Bluetooth_Driver import BluetoothCANDriver, BLUETOOTH_AVAILABLE, CANMessage as BluetoothCANMessage, get_paired_bluetooth_devices
    BLUETOOTH_CAN_AVAILABLE = BLUETOOTH_AVAILABLE
except ImportError:
    BLUETOOTH_CAN_AVAILABLE = False
    get_paired_bluetooth_devices = lambda: []
    print("Warning: Bluetooth_Driver not available")

# Import firmware flasher
try:
    from drivers.Firmware_Flasher import FirmwareFlasher
    FIRMWARE_FLASHER_AVAILABLE = True
except ImportError:
    FIRMWARE_FLASHER_AVAILABLE = False
    print("Warning: Firmware_Flasher not available")

# Import DBC support
try:
    import cantools
    DBC_SUPPORT = True
except ImportError:
    DBC_SUPPORT = False
    print("Warning: cantools not installed. DBC support disabled.")


# ============================================================================
# Pydantic Models (API Request/Response Schemas)
# ============================================================================

class DeviceType(str, Enum):
    """Supported CAN device types"""
    PCAN = "pcan"
    CANABLE = "canable"
    NETWORK = "network"
    BLUETOOTH = "bluetooth"


class ConnectionRequest(BaseModel):
    """Request to connect to a CAN device"""
    device_type: DeviceType
    channel: Union[str, int]  # Channel name for PCAN or device index for CANable
    baudrate: str  # e.g., "BAUD_500K"


class ConnectionResponse(BaseModel):
    """Response from connection attempt"""
    success: bool
    message: str
    device_type: Optional[str] = None
    channel: Optional[Union[str, int]] = None
    baudrate: Optional[str] = None


class DisconnectionResponse(BaseModel):
    """Response from disconnection attempt"""
    success: bool
    message: str


class DeviceInfo(BaseModel):
    """Information about an available CAN device"""
    device_type: str
    index: int
    name: str
    description: str
    available: bool
    occupied: Optional[bool] = None


class DeviceListResponse(BaseModel):
    """Response containing list of available devices"""
    pcan_available: bool
    canable_available: bool
    devices: List[DeviceInfo]


class BusStatusResponse(BaseModel):
    """Current bus status information"""
    connected: bool
    device_type: Optional[str] = None
    channel: Optional[Union[str, int]] = None
    baudrate: Optional[str] = None
    status: Optional[str] = None
    interface: Optional[str] = None


class CANMessageRequest(BaseModel):
    """Request to send a CAN message"""
    can_id: int
    data: List[int]  # List of bytes (0-255)
    is_extended: bool = False
    is_remote: bool = False


class CANMessageResponse(BaseModel):
    """Response after sending a CAN message"""
    success: bool
    message: str


class CANMessageData(BaseModel):
    """CAN message data structure"""
    id: int
    data: List[int]
    timestamp: float
    is_extended: bool
    is_remote: bool
    dlc: int


class DBCLoadRequest(BaseModel):
    """Request to load a DBC file"""
    file_path: str


class DBCLoadResponse(BaseModel):
    """Response from DBC file loading"""
    success: bool
    message: str
    file_path: Optional[str] = None
    message_count: Optional[int] = None


class TransmitListItem(BaseModel):
    """Single item in the transmit list"""
    id: str  # Unique ID for this item
    can_id: int
    data: List[int]  # List of bytes (0-255)
    is_extended: bool = False
    message_name: Optional[str] = None  # DBC message name if from DBC
    signals: Optional[Dict[str, Union[int, float, str]]] = None  # Signal values if from DBC
    description: Optional[str] = None
    cycle_time: Optional[int] = None  # Cycle time in ms for cyclic sending


class TransmitListResponse(BaseModel):
    """Response containing transmit list"""
    success: bool
    items: List[TransmitListItem]
    dbc_file: Optional[str] = None


class SaveTransmitListRequest(BaseModel):
    """Request to save transmit list"""
    items: List[TransmitListItem]
    dbc_file: str


class DBCMessageInfo(BaseModel):
    """Information about a DBC message"""
    name: str
    frame_id: int
    is_extended: bool
    dlc: int
    length: int
    signal_count: int
    signals: List[dict]


class DBCMessagesResponse(BaseModel):
    """Response containing DBC message list"""
    success: bool
    messages: List[DBCMessageInfo]


class FirmwareFlashResponse(BaseModel):
    """Response from firmware flash operation"""
    success: bool
    message: str
    error: Optional[str] = None


# ============================================================================
# Backend Application State
# ============================================================================

class CANBackend:
    """Backend state management for CAN communication"""
    
    def __init__(self):
        self.driver: Optional[Union[PCANDriver, CANableDriver, 'NetworkCANDriver']] = None
        self.device_type: Optional[DeviceType] = None
        self.is_connected: bool = False
        self.dbc_database: Optional['cantools.database.Database'] = None
        self.dbc_file_path: Optional[str] = None
        
        # WebSocket connections
        self.active_connections: List[WebSocket] = []
        
        # Message statistics
        self.message_count: int = 0
        self.start_time: Optional[datetime] = None
        
        # Event loop for async operations from threads
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.start_time: Optional[datetime] = None
        self.connection_state: str = 'disconnected'
        self.connection_reason: Optional[str] = None
        self._health_monitor_task: Optional[asyncio.Task] = None
        self._simulation_task: Optional[asyncio.Task] = None
        self._simulation_current_task: Optional[asyncio.Task] = None
        self._simulation_active: bool = False
        self._simulation_started_monotonic: Optional[float] = None
        self._shutdown_called: bool = False
        self._recovery_in_progress: bool = False

    def _is_driver_healthy(self) -> bool:
        """Check current driver health."""
        if not self.is_connected or not self.driver:
            return False

        try:
            if hasattr(self.driver, 'health_check'):
                return bool(self.driver.health_check())

            status = self.driver.get_bus_status()
            return bool(status.get('connected', False))
        except Exception as e:
            print(f"[Health] Driver health check failed: {e}")
            return False

    async def _run_health_monitor(self):
        """Background monitor that auto-recovers connections after sleep/wake or hardware loss."""
        print("[Health] Monitor started")
        try:
            while not self._shutdown_called:
                await asyncio.sleep(5.0)

                if self._shutdown_called:
                    break

                if not self.is_connected or not self.driver or self._recovery_in_progress:
                    continue

                healthy = await asyncio.to_thread(self._is_driver_healthy)
                if not healthy:
                    await self._handle_connection_loss("driver_health_check_failed")
        except asyncio.CancelledError:
            pass
        finally:
            print("[Health] Monitor stopped")

    def start_health_monitor(self):
        """Ensure health monitor task is running."""
        if self.loop and (self._health_monitor_task is None or self._health_monitor_task.done()):
            self._health_monitor_task = asyncio.create_task(self._run_health_monitor())

    async def stop_health_monitor(self):
        """Stop health monitor task."""
        if self._health_monitor_task and not self._health_monitor_task.done():
            self._health_monitor_task.cancel()
            try:
                await self._health_monitor_task
            except asyncio.CancelledError:
                pass
        self._health_monitor_task = None

    async def broadcast_connection_status(self, status: str, reason: Optional[str] = None):
        """Broadcast connection status updates to all websocket clients."""
        payload = {
            "type": "connection_status",
            "status": status,
            "timestamp": datetime.now().isoformat()
        }
        if reason:
            payload["reason"] = reason
        await self.broadcast_message(payload)

    async def _handle_connection_loss(self, reason: str):
        """Attempt automatic reconnection when health check fails."""
        if self._recovery_in_progress or not self.is_connected or not self.driver:
            return

        self._recovery_in_progress = True
        self.connection_state = 'reconnecting'
        self.connection_reason = reason
        await self.broadcast_connection_status('reconnecting', reason)

        try:
            for attempt in range(1, 4):
                print(f"[Recovery] Attempt {attempt}/3")
                success = await asyncio.to_thread(self._attempt_driver_reconnect)
                if success:
                    self.connection_state = 'connected'
                    self.connection_reason = 'recovered'
                    await self.broadcast_connection_status('connected', 'recovered')
                    print("[Recovery] Connection restored")
                    return

                await asyncio.sleep(2 ** (attempt - 1))

            print("[Recovery] Failed to recover connection")
            await asyncio.to_thread(self.disconnect)
            self.connection_state = 'disconnected'
            self.connection_reason = 'hardware_lost'
            await self.broadcast_connection_status('disconnected', 'hardware_lost')
        finally:
            self._recovery_in_progress = False

    def _attempt_driver_reconnect(self) -> bool:
        """Reconnect using driver-provided reconnect hook."""
        if not self.driver or not hasattr(self.driver, 'reconnect'):
            return False

        try:
            success = bool(self.driver.reconnect())
            if not success:
                return False

            if hasattr(self.driver, 'start_receive_thread'):
                try:
                    self.driver.start_receive_thread(self._on_message_received)
                except Exception as e:
                    print(f"[Recovery] Warning starting receive thread: {e}")

            self.is_connected = True
            self.start_time = datetime.now()
            return True
        except Exception as e:
            print(f"[Recovery] Reconnect error: {e}")
            return False

    async def shutdown(self):
        """Idempotent backend shutdown cleanup."""
        if self._shutdown_called:
            return

        self._shutdown_called = True
        await self.stop_simulation()
        await self.stop_health_monitor()

        if self.is_connected:
            await asyncio.to_thread(self.disconnect)

        for ws in list(self.active_connections):
            try:
                await ws.close()
            except Exception:
                pass
        self.active_connections.clear()
    
    def get_available_devices(self) -> List[DeviceInfo]:
        """Get list of all available CAN devices"""
        devices = []
        
        # PCAN devices
        if PCAN_AVAILABLE:
            try:
                pcan_driver = PCANDriver()
                pcan_devices = pcan_driver.get_available_devices()
                for idx, dev in enumerate(pcan_devices):
                    devices.append(DeviceInfo(
                        device_type="pcan",
                        index=idx,
                        name=dev['channel'],
                        description=f"PCAN {dev['channel']}",
                        available=dev['available'],
                        occupied=dev.get('occupied', False)
                    ))
            except Exception as e:
                print(f"Error scanning PCAN devices: {e}")
        
        # CANable devices
        if CANABLE_AVAILABLE:
            try:
                canable_driver = CANableDriver()
                canable_devices = canable_driver.get_available_devices()
                for dev in canable_devices:
                    devices.append(DeviceInfo(
                        device_type="canable",
                        index=dev['index'],
                        name=f"Device {dev['index']}",
                        description=dev.get('description', f"CANable Device {dev['index']}"),
                        available=True
                    ))
            except Exception as e:
                print(f"Error scanning CANable devices: {e}")
        
        # Network CAN devices (always show as option if driver available)
        if NETWORK_CAN_AVAILABLE:
            devices.append(DeviceInfo(
                device_type="network",
                index=0,
                name="Network CAN Server",
                description="Connect to remote CAN server via IP:Port",
                available=True
            ))
        
        # Bluetooth CAN devices (Windows only - scan for paired Bluetooth devices)
        if BLUETOOTH_CAN_AVAILABLE:
            try:
                paired_devices = get_paired_bluetooth_devices()
                for idx, device in enumerate(paired_devices):
                    devices.append(DeviceInfo(
                        device_type="bluetooth",
                        index=idx,
                        name=device['address'],
                        description=f"{device['name']} ({device['address']})",
                        available=True
                    ))
                # Always add a manual entry option
                devices.append(DeviceInfo(
                    device_type="bluetooth",
                    index=len(paired_devices),
                    name="Bluetooth CAN Server",
                    description="Connect via Bluetooth address (XX:XX:XX:XX:XX:XX)",
                    available=True
                ))
            except Exception as e:
                print(f"Error scanning Bluetooth devices: {e}")
        
        return devices
    
    def connect(self, device_type: DeviceType, channel: Union[str, int], baudrate: str) -> bool:
        """Connect to a CAN device"""
        if self._simulation_active:
            print("[Connect] Refusing real hardware connect while simulation is active")
            return False

        if self.is_connected:
            return False

        self.connection_reason = None
        
        try:
            # Create appropriate driver
            if device_type == DeviceType.PCAN:
                if not PCAN_AVAILABLE:
                    raise Exception("PCAN driver not available")
                
                self.driver = PCANDriver()

                # Accept several PCAN channel formats from clients/UI.
                if isinstance(channel, int):
                    # Allow index-like values where 0 maps to USB1.
                    pcan_channel_name = f"USB{channel + 1 if channel < 1 else channel}"
                else:
                    channel_str = str(channel).strip().upper()
                    if ':' in channel_str:
                        channel_str = channel_str.split(':', 1)[0].strip()
                    if ' ' in channel_str:
                        channel_str = channel_str.split(' ', 1)[0].strip()
                    if channel_str.startswith('PCAN_USBBUS'):
                        suffix = channel_str.replace('PCAN_USBBUS', '').strip()
                        channel_str = f"USB{suffix}"
                    if channel_str.startswith('USBBUS'):
                        suffix = channel_str.replace('USBBUS', '').strip()
                        channel_str = f"USB{suffix}"
                    if channel_str.isdigit():
                        idx = int(channel_str)
                        channel_str = f"USB{idx + 1 if idx < 1 else idx}"
                    pcan_channel_name = channel_str

                try:
                    pcan_channel = PCANChannel[pcan_channel_name]
                except KeyError:
                    valid_channels = ', '.join(ch.name for ch in PCANChannel)
                    raise Exception(f"Invalid PCAN channel '{channel}'. Valid channels: {valid_channels}")

                pcan_baudrate = PCANBaudRate[baudrate]
                
                if not self.driver.connect(pcan_channel, pcan_baudrate):
                    driver_error = getattr(self.driver, 'last_error', None)
                    if driver_error:
                        raise Exception(driver_error)
                    raise Exception(f"Failed to connect PCAN channel {pcan_channel.name}")
                
            elif device_type == DeviceType.CANABLE:
                if not CANABLE_AVAILABLE:
                    raise Exception("CANable driver not available")
                
                self.driver = CANableDriver()
                canable_baudrate = CANableBaudRate[baudrate]
                
                # Handle both formats: "Device X: Description" or just the index number
                if isinstance(channel, str):
                    # Extract device index from "Device X: Description" format if needed
                    if channel.startswith("Device "):
                        try:
                            channel_index = int(channel.split(":")[0].split()[1])
                        except:
                            channel_index = int(channel)
                    else:
                        channel_index = int(channel)
                else:
                    channel_index = int(channel)
                
                if not self.driver.connect(channel_index, canable_baudrate):
                    return False
            
            elif device_type == DeviceType.NETWORK:
                if not NETWORK_CAN_AVAILABLE:
                    raise Exception("Network CAN driver not available")
                
                # Parse channel as host:port (e.g., "192.168.1.100:8080")
                if isinstance(channel, str) and ':' in channel:
                    host, port_str = channel.rsplit(':', 1)
                    port = int(port_str)
                else:
                    raise Exception("Network channel must be in format 'host:port' (e.g., '192.168.1.100:8080')")
                
                # Map baudrate string to NetworkCANBaudRate enum
                network_baudrate = NetworkCANBaudRate[baudrate]
                
                self.driver = NetworkCANDriver(host=host, port=port)
                
                # Test connection first
                if not self.driver.test_connection():
                    return False
                
                # Connect with the specified baudrate and auto-connect to server
                if not self.driver.connect(baudrate=network_baudrate, auto_connect_server=True):
                    return False
            
            elif device_type == DeviceType.BLUETOOTH:
                if not BLUETOOTH_CAN_AVAILABLE:
                    raise Exception("Bluetooth CAN driver not available (requires Windows 10/11 + Python 3.9+)")
                
                # Channel format: "XX:XX:XX:XX:XX:XX" or "XX:XX:XX:XX:XX:XX:1" (address:channel)
                # Default RFCOMM channel is 1
                bt_address = str(channel).strip()
                rfcomm_channel = 1
                
                # Check if channel is specified at the end (e.g., "XX:XX:XX:XX:XX:XX:1")
                if bt_address.count(':') == 6:
                    # Has 6 colons, meaning address:channel format
                    parts = bt_address.rsplit(':', 1)
                    bt_address = parts[0]
                    try:
                        rfcomm_channel = int(parts[1])
                    except ValueError:
                        rfcomm_channel = 1
                
                self.driver = BluetoothCANDriver()
                
                # Connect to the Bluetooth server
                if not self.driver.connect(address=bt_address, channel=rfcomm_channel):
                    return False
            
            else:
                raise Exception(f"Unknown device type: {device_type}")
            
            # Start receive thread
            self.driver.start_receive_thread(self._on_message_received)
            
            self.device_type = device_type
            self.is_connected = True
            self.connection_state = 'connected'
            self.connection_reason = None
            self.start_time = datetime.now()
            self.message_count = 0
            
            # For Network/Bluetooth drivers, upload DBC to server if already loaded locally
            if device_type in (DeviceType.NETWORK, DeviceType.BLUETOOTH) and self.dbc_file_path:
                try:
                    if hasattr(self.driver, 'upload_dbc'):
                        if self.driver.upload_dbc(self.dbc_file_path):
                            print(f"[Connect] DBC uploaded to remote server: {self.dbc_file_path}")
                        else:
                            print(f"[Connect] Warning: Failed to upload DBC to remote server")
                except Exception as e:
                    print(f"[Connect] Warning: DBC upload failed: {e}")
            
            return True
            
        except Exception as e:
            print(f"Connection error: {e}")
            self.connection_reason = str(e)
            self.driver = None
            self.device_type = None
            self.is_connected = False
            return False
    
    def disconnect(self) -> bool:
        """Disconnect from CAN device"""
        if not self.is_connected or not self.driver:
            return False
        
        device_name = self.device_type.value if self.device_type else "unknown"
        print(f"[Disconnect] Disconnecting from {device_name}...")
        
        try:
            # Stop receive thread first if available
            if hasattr(self.driver, 'stop_receive_thread'):
                try:
                    self.driver.stop_receive_thread()
                    print("[Disconnect] Receive thread stopped")
                except Exception as e:
                    print(f"[Disconnect] Warning stopping receive thread: {e}")
            
            # Disconnect from device
            try:
                self.driver.disconnect()
                print("[Disconnect] Driver disconnected")
            except Exception as e:
                print(f"[Disconnect] Warning during driver disconnect: {e}")
            
            self.driver = None
            self.is_connected = False
            self.device_type = None
            self.connection_state = 'disconnected'
            self.connection_reason = None
            print("[Disconnect] Cleanup complete")
            return True
        except Exception as e:
            print(f"[Disconnect] Error: {e}")
            # Force cleanup even on error
            self.driver = None
            self.is_connected = False
            self.device_type = None
            self.connection_state = 'disconnected'
            self.connection_reason = str(e)
            return False
    
    def send_message(self, can_id: int, data: List[int], 
                    is_extended: bool = False, is_remote: bool = False) -> bool:
        """Send a CAN message"""
        if not self.is_connected or not self.driver:
            return False
        
        try:
            data_bytes = bytes(data)
            return self.driver.send_message(can_id, data_bytes, is_extended, is_remote)
        except Exception as e:
            print(f"Send error: {e}")
            return False
    
    def get_bus_status(self) -> dict:
        """Get current bus status"""
        if self._simulation_active:
            return {
                'connected': True,
                'device_type': 'simulation',
                'channel': 'bms-fake-data',
                'baudrate': 'SIM',
                'status': 'Connected (Test Mode)',
                'interface': 'simulation'
            }

        if not self.is_connected or not self.driver:
            return {
                'connected': False,
                'status': self.connection_state.title() if self.connection_state else 'Disconnected'
            }
        
        status = self.driver.get_bus_status()
        status['device_type'] = self.device_type.value if self.device_type else None
        status['status'] = self.connection_state.title()
        return status

    def get_connection_health(self) -> dict:
        """Get connection health and recovery state for frontend wake handling."""
        return {
            'connected': self.is_connected,
            'connection_state': self.connection_state,
            'recovery_in_progress': self._recovery_in_progress,
            'reason': self.connection_reason,
            'device_type': self.device_type.value if self.device_type else None,
            'simulation_active': self._simulation_active
        }

    def is_simulation_active(self) -> bool:
        """Return whether fake BMS simulation mode is active."""
        return self._simulation_active

    async def start_simulation(self) -> bool:
        """Start generating fake BMS CAN data from DBC definitions."""
        if self._simulation_active:
            return True

        if self.is_connected and self.driver:
            # Real hardware is connected, don't mix simulation with live bus.
            return False

        if not DBC_SUPPORT:
            return False

        # Ensure BMS DBC is loaded for encode/decode metadata.
        # Require both core heartbeat and pack-current message support.
        needs_bms_load = True
        if self.dbc_database:
            try:
                self.dbc_database.get_message_by_name("BMS_Heartbeat_0")
                self.dbc_database.get_message_by_name("Current_Sensor_Data")
                needs_bms_load = False
            except Exception:
                needs_bms_load = True

        if needs_bms_load:
            bms_dbc_path = DBC_DIR / "BMS-Firmware-RTOS-Complete.dbc"
            if not bms_dbc_path.exists():
                return False
            if not self.load_dbc_file(str(bms_dbc_path)):
                return False

        self.is_connected = True
        self.device_type = None
        self.connection_state = 'connected'
        self.connection_reason = 'simulation'
        self.start_time = datetime.now()
        self.message_count = 0
        self._simulation_active = True
        self._simulation_started_monotonic = time.perf_counter()

        self._simulation_task = asyncio.create_task(self._run_simulation())
        self._simulation_current_task = asyncio.create_task(self._run_simulated_current_sensor())
        return True

    async def stop_simulation(self) -> bool:
        """Stop fake BMS CAN data simulation."""
        if not self._simulation_active:
            return True

        self._simulation_active = False

        if self._simulation_task and not self._simulation_task.done():
            self._simulation_task.cancel()
            try:
                await self._simulation_task
            except asyncio.CancelledError:
                pass

        if self._simulation_current_task and not self._simulation_current_task.done():
            self._simulation_current_task.cancel()
            try:
                await self._simulation_current_task
            except asyncio.CancelledError:
                pass

        self._simulation_task = None
        self._simulation_current_task = None
        self._simulation_started_monotonic = None
        self.is_connected = False
        self.connection_state = 'disconnected'
        self.connection_reason = 'simulation_stopped'
        self.device_type = None
        return True

    def _build_simulated_message(self, can_id: int, payload: bytes, is_extended: bool) -> dict:
        """Build a websocket message payload from simulated CAN bytes."""
        message_data = {
            'id': can_id,
            'data': list(payload),
            'timestamp': time.time(),
            'is_extended': is_extended,
            'is_remote': False,
            'dlc': len(payload)
        }

        if self.dbc_database:
            decoded = self.decode_message(can_id, payload, is_extended)
            if decoded:
                message_data['decoded'] = decoded

        return message_data

    async def _emit_simulated_message(self, message_name: str, signals: Dict[str, Union[int, float]]):
        """Encode and broadcast one simulated CAN message by DBC message name."""
        if not self.dbc_database:
            return

        try:
            message = self.dbc_database.get_message_by_name(message_name)
            payload = message.encode(signals)
            is_extended = message.frame_id > 0x7FF
            can_id = message.frame_id
            message_data = self._build_simulated_message(can_id, payload, is_extended)
            self.message_count += 1
            await self.broadcast_message(message_data)
        except Exception as e:
            print(f"[SIM] Failed to emit {message_name}: {e}")

    def _get_simulation_elapsed(self) -> float:
        """Return elapsed simulation time in seconds using monotonic clock."""
        if self._simulation_started_monotonic is None:
            return 0.0
        return max(0.0, time.perf_counter() - self._simulation_started_monotonic)

    def _build_simulated_currents(self, elapsed: float) -> tuple[float, float]:
        """Generate deterministic-but-dynamic LC/HC current values."""
        cycle_seconds = 50.0
        base_phase = (elapsed % cycle_seconds) / cycle_seconds

        if base_phase < 0.5:
            base_level = base_phase * 2.0
        else:
            base_level = (1.0 - base_phase) * 2.0

        lc_current = 5.0 + (115.0 * base_level)
        lc_current += 2.8 * math.sin((elapsed * 0.8) + 0.35)
        lc_current += random.uniform(-1.2, 1.2)
        lc_current = max(5.0, min(120.0, lc_current))

        hc_current = lc_current + (3.0 * math.sin((elapsed * 1.2) + 1.1))
        hc_current += random.uniform(-0.8, 0.8)
        hc_current = max(5.0, min(120.0, hc_current))

        return round(lc_current, 1), round(hc_current, 1)

    async def _run_simulated_current_sensor(self):
        """Emit Current_Sensor_Data at a fixed 10 ms cadence while simulation is active."""
        try:
            if not self.dbc_database:
                return

            try:
                self.dbc_database.get_message_by_name("Current_Sensor_Data")
            except Exception:
                return

            emit_interval_s = 0.01
            next_emit = time.perf_counter()

            while self._simulation_active:
                elapsed = self._get_simulation_elapsed()
                lc_current, hc_current = self._build_simulated_currents(elapsed)

                await self._emit_simulated_message(
                    "Current_Sensor_Data",
                    {
                        "LC_Current": lc_current,
                        "HC_Current": hc_current,
                        "Reserved_4": 0,
                        "Reserved_5": 0,
                        "Reserved_6": 0,
                        "Reserved_7": 0
                    }
                )

                next_emit += emit_interval_s
                sleep_for = next_emit - time.perf_counter()
                if sleep_for > 0:
                    await asyncio.sleep(sleep_for)
                else:
                    # If delayed by scheduler load, skip ahead to preserve ~10 ms cadence.
                    missed_intervals = int((-sleep_for) // emit_interval_s) + 1
                    next_emit += missed_intervals * emit_interval_s
                    await asyncio.sleep(0)
        except asyncio.CancelledError:
            pass

    async def _run_simulation(self):
        """Main fake-data loop with rise/fall wave and center-lag thermal/electrical gradients."""
        print("[SIM] BMS simulation started")

        # Simulation bounds requested by user.
        temp_min = 20.0
        temp_max = 60.0
        voltage_min = 3200.0
        voltage_max = 4200.0

        cycle_seconds = 50.0  # One full rise-and-fall cycle.

        def normalized_triangle(phase: float) -> tuple[float, bool]:
            """Return (0..1 value, rising_phase)."""
            phase = phase % 1.0
            if phase < 0.5:
                return phase * 2.0, True
            return (1.0 - phase) * 2.0, False

        def center_closeness(local_index: int, max_index: int, center_idx: float) -> float:
            """1.0 at center, 0.0 at far edges."""
            half_span = max(center_idx, max_index - center_idx)
            if half_span <= 0:
                return 0.0
            return max(0.0, 1.0 - (abs(local_index - center_idx) / half_span))

        def phase_response(closeness: float, rising: bool) -> float:
            """Middle cells 7-13 heat slower and cool first/faster."""
            if rising:
                # Center lags while heating.
                return 1.0 - (0.42 * closeness)
            # Center leads while cooling.
            return 1.0 + (0.55 * closeness)

        def hotspot_curve(x: float, center: float, width: float) -> float:
            """Smooth 0..1 bump used to build non-uniform local hot/cold regions."""
            if width <= 0:
                return 0.0
            normalized = (x - center) / width
            return max(0.0, 1.0 - (normalized * normalized))

        # Persistent per-thermistor profile so readings are varied, not a flat gradient.
        temp_gain = [0.82 + random.uniform(-0.08, 0.18) for _ in range(336)]
        temp_phase_offset = [random.uniform(-0.09, 0.09) for _ in range(336)]
        temp_sensor_bias = [random.uniform(-1.6, 1.8) for _ in range(336)]
        temp_jitter_amp = [0.15 + random.uniform(0.0, 0.45) for _ in range(336)]

        # Cache actual DBC signal names per temperature message so ambient renames are handled.
        temp_message_signal_names: Dict[str, set[str]] = {}
        for module in range(6):
            temp_module_base = module * 56
            for temp_group in range(14):
                temp_start = temp_module_base + (temp_group * 4)
                temp_end = temp_start + 3
                message_name = f"Cell_Temp_{temp_start}_{temp_end}"
                try:
                    msg = self.dbc_database.get_message_by_name(message_name)
                    temp_message_signal_names[message_name] = {sig.name for sig in msg.signals}
                except Exception:
                    temp_message_signal_names[message_name] = set()

        # Build module-local hotspot maps (different regions warm/cool at different rates).
        module_hotspot_profiles: List[List[float]] = []
        for _ in range(6):
            hotspot_centers = [
                random.uniform(6.0, 20.0),
                random.uniform(24.0, 36.0),
                random.uniform(38.0, 52.0)
            ]
            hotspot_strengths = [
                random.uniform(1.0, 2.8),
                random.uniform(-1.1, 1.7),
                random.uniform(0.9, 2.5)
            ]
            hotspot_widths = [
                random.uniform(4.0, 8.0),
                random.uniform(3.0, 7.0),
                random.uniform(4.5, 9.0)
            ]

            profile: List[float] = []
            for local_idx in range(56):
                value = 0.0
                for center, strength, width in zip(hotspot_centers, hotspot_strengths, hotspot_widths):
                    value += strength * hotspot_curve(float(local_idx), center, width)
                profile.append(value)
            module_hotspot_profiles.append(profile)

        start_time = time.time()

        try:
            while self._simulation_active:
                elapsed = time.time() - start_time
                base_phase = (elapsed % cycle_seconds) / cycle_seconds
                base_level, is_rising = normalized_triangle(base_phase)

                for module in range(6):
                    temp_module_base = module * 56
                    voltage_module_base = module * 18

                    # Slight pack-level gradient so modules are not identical.
                    module_temp_offset = (module - 2.5) * 0.8
                    module_voltage_offset = (module - 2.5) * 18.0

                    # 14 temperature frames per module, 4 temperatures each.
                    for temp_group in range(14):
                        start_idx = temp_module_base + (temp_group * 4)
                        temp_start = temp_module_base + (temp_group * 4)
                        temp_end = temp_start + 3
                        temp_message_name = f"Cell_Temp_{temp_start}_{temp_end}"
                        signal_name_set = temp_message_signal_names.get(temp_message_name, set())
                        signal_payload: Dict[str, float] = {}
                        for offset in range(4):
                            thermistor_idx = start_idx + offset
                            local_temp_idx = thermistor_idx - temp_module_base  # 0..55

                            # Map thermistor position into a pseudo 18-cell span to mirror cell 7-13 behavior.
                            pseudo_cell_idx = int(round((local_temp_idx / 55.0) * 17.0))
                            center_factor = center_closeness(pseudo_cell_idx, 17, 9.0)
                            response = phase_response(center_factor, is_rising)

                            # Add per-sensor phase skew and gain for richer thermal behavior.
                            local_phase = (base_phase + temp_phase_offset[thermistor_idx]) % 1.0
                            local_level, _ = normalized_triangle(local_phase)
                            effective_level = min(1.0, max(0.0, local_level * response * temp_gain[thermistor_idx]))

                            temp_value = temp_min + ((temp_max - temp_min) * effective_level)

                            # Hotspots intensify while heating and fade during cooling.
                            hotspot_scale = 0.35 + (1.15 * base_level if is_rising else 0.55 * base_level)
                            hotspot_value = module_hotspot_profiles[module][local_temp_idx] * hotspot_scale

                            # Mixed-frequency ripple to avoid smooth/linear appearance.
                            thermal_wave = (
                                0.6 * math.sin((elapsed * 0.45) + (local_temp_idx * 0.31) + (module * 0.9)) +
                                0.35 * math.sin((elapsed * 0.9) + (local_temp_idx * 0.11) + (module * 1.7))
                            )

                            temp_value += module_temp_offset
                            temp_value += temp_sensor_bias[thermistor_idx]
                            temp_value += hotspot_value
                            temp_value += thermal_wave
                            temp_value += random.uniform(-temp_jitter_amp[thermistor_idx], temp_jitter_amp[thermistor_idx])
                            temp_value = max(temp_min, min(temp_max, temp_value))

                            default_name = f"Temp_{thermistor_idx:03d}"
                            ambient1_name = f"Ambient_Temp_1_{thermistor_idx:03d}"
                            ambient2_name = f"Ambient_Temp_2_{thermistor_idx:03d}"

                            # Use the exact signal name from DBC for the last two channels.
                            if local_temp_idx == 54 and ambient1_name in signal_name_set:
                                signal_name = ambient1_name
                            elif local_temp_idx == 55 and ambient2_name in signal_name_set:
                                signal_name = ambient2_name
                            elif default_name in signal_name_set or not signal_name_set:
                                signal_name = default_name
                            elif ambient1_name in signal_name_set:
                                signal_name = ambient1_name
                            elif ambient2_name in signal_name_set:
                                signal_name = ambient2_name
                            else:
                                signal_name = default_name

                            signal_payload[signal_name] = round(temp_value, 1)

                        await self._emit_simulated_message(
                            temp_message_name,
                            signal_payload
                        )

                    # 6 cell-voltage frames per module, 3 voltages each.
                    for voltage_group in range(6):
                        start_idx = voltage_module_base + (voltage_group * 3)
                        signal_payload: Dict[str, int] = {}
                        for offset in range(3):
                            cell_idx = start_idx + offset
                            local_cell_idx = cell_idx - voltage_module_base  # 0..17

                            # Center cells (7-13 -> roughly local 6..12) lag on rise and cool first.
                            center_factor = center_closeness(local_cell_idx, 17, 9.0)
                            response = phase_response(center_factor, is_rising)

                            # Add slight phase spread across pack so gradients are visible.
                            local_phase = (base_phase + (local_cell_idx / 18.0) * 0.08) % 1.0
                            local_level, _ = normalized_triangle(local_phase)
                            effective_level = min(1.0, max(0.0, local_level * response))

                            voltage_value = voltage_min + ((voltage_max - voltage_min) * effective_level)
                            voltage_value += module_voltage_offset + random.uniform(-2.0, 2.0)
                            voltage_value = max(voltage_min, min(voltage_max, voltage_value))

                            signal_payload[f"Cell_{cell_idx + 1:03d}_Voltage"] = int(round(voltage_value))

                        cell_start = 1 + voltage_module_base + (voltage_group * 3)
                        cell_end = cell_start + 2
                        await self._emit_simulated_message(
                            f"Cell_Voltage_{cell_start}_{cell_end}",
                            signal_payload
                        )

                    await self._emit_simulated_message(
                        f"BMS_Heartbeat_{module}",
                        {
                            "BMS_State": 1,
                            "Error_Flags_Byte0": 0,
                            "Error_Flags_Byte1": 0,
                            "Error_Flags_Byte2": 0,
                            "Error_Flags_Byte3": 0,
                            "Warning_Summary": 0,
                            "Fault_Count": 0
                        }
                    )

                await asyncio.sleep(0.2)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"[SIM] Simulation loop crashed: {e}")
            self._simulation_active = False
        finally:
            print("[SIM] BMS simulation stopped")
    
    def load_dbc_file(self, file_path: str) -> bool:
        """Load a DBC file for message decoding
        
        For Network driver: uploads DBC to remote server for server-side decoding
        For local drivers (PCAN, CANable): loads DBC locally for client-side decoding
        """
        if not DBC_SUPPORT:
            return False
        
        try:
            # Always load locally for DBC message info and local decoding fallback
            self.dbc_database = cantools.database.load_file(file_path, strict=False)
            self.dbc_file_path = file_path
            
            # For Network/Bluetooth driver, also upload DBC to remote server for server-side decoding
            if self.device_type in (DeviceType.NETWORK, DeviceType.BLUETOOTH) and self.driver:
                try:
                    if hasattr(self.driver, 'upload_dbc'):
                        if self.driver.upload_dbc(file_path):
                            print(f"[DBC] Uploaded to remote server: {file_path}")
                        else:
                            print(f"[DBC] Warning: Failed to upload to remote server, using local decoding")
                except Exception as e:
                    print(f"[DBC] Warning: Remote upload failed: {e}, using local decoding")
            
            return True
        except Exception as e:
            print(f"DBC load error: {e}")
            return False
    
    def get_dbc_messages(self) -> List[dict]:
        """Get list of messages from loaded DBC file"""
        if not self.dbc_database:
            return []
        
        messages = []
        for msg in self.dbc_database.messages:
            try:
                is_extended = msg.frame_id > 0x7FF
                actual_id = msg.frame_id & 0x1FFFFFFF if is_extended else msg.frame_id
                
                signals = []
                for signal in msg.signals:
                    # Convert choices to plain dict (cantools returns NamedSignalValue objects)
                    choices_dict = {}
                    if signal.choices:
                        choices_dict = {int(k): str(v) for k, v in signal.choices.items()}
                    
                    signals.append({
                        'name': signal.name,
                        'start_bit': signal.start,
                        'length': signal.length,
                        'byte_order': signal.byte_order,
                        'scale': signal.scale,
                        'offset': signal.offset,
                        'minimum': signal.minimum,
                        'maximum': signal.maximum,
                        'unit': signal.unit or '',
                        'choices': choices_dict
                    })
                
                # Ensure length is an integer, default to 8 if not set
                msg_length = msg.length if msg.length is not None else 8
                
                messages.append({
                    'name': msg.name,
                    'frame_id': actual_id,
                    'is_extended': is_extended,
                    'dlc': msg_length,
                    'length': msg_length,
                    'signal_count': len(signals),
                    'signals': signals
                })
            except Exception as e:
                print(f"Error processing message {msg.name}: {e}")
                continue
        
        return messages
    
    def decode_message(self, can_id: int, data: bytes, is_extended: bool = False) -> Optional[dict]:
        """Decode a CAN message using DBC"""
        if not self.dbc_database:
            print(f"[DECODE] No DBC database loaded")
            return None
        
        try:
            # Cantools stores extended IDs with the extended bit (0x80000000) stripped off
            # So we need to mask it when looking up extended IDs
            if is_extended:
                lookup_id = can_id & 0x1FFFFFFF  # Strip extended bit if present
            else:
                lookup_id = can_id
            
            print(f"[DECODE] Attempting to decode: can_id=0x{can_id:X}, is_extended={is_extended}, lookup_id=0x{lookup_id:X}")
            message = self.dbc_database.get_message_by_frame_id(lookup_id)
            print(f"[DECODE] Found message: {message.name}")
            decoded = message.decode(data)
            
            # Convert NamedSignalValue objects to regular Python types for JSON serialization
            # If a signal has enumerated values (VAL_ in DBC), use the name; otherwise use the numeric value
            # Also include units and other metadata from the signal definition
            signals = {}
            for key, value in decoded.items():
                # Get the signal definition for metadata
                signal = message.get_signal_by_name(key)
                
                # Extract the display value (enum name or numeric value)
                if hasattr(value, 'name') and value.name is not None:
                    # Use the enumerated text label (e.g., "FAULT" instead of 5)
                    display_value = value.name
                    raw_value = value.value
                elif hasattr(value, 'value'):
                    # No enum, just use the numeric value
                    display_value = value.value
                    raw_value = value.value
                else:
                    # Plain value (shouldn't happen with cantools, but just in case)
                    display_value = value
                    raw_value = value
                
                # Build signal info with metadata
                signal_info = {
                    'value': display_value,
                }
                
                # Add raw numeric value if different from display (for enums)
                if isinstance(display_value, str) and isinstance(raw_value, (int, float)):
                    signal_info['raw'] = raw_value
                
                # Add unit if available
                if signal.unit:
                    signal_info['unit'] = signal.unit
                
                # Add scale and offset if non-default
                if signal.scale != 1:
                    signal_info['scale'] = signal.scale
                if signal.offset != 0:
                    signal_info['offset'] = signal.offset
                
                # Add min/max range if specified
                if signal.minimum is not None:
                    signal_info['min'] = signal.minimum
                if signal.maximum is not None:
                    signal_info['max'] = signal.maximum
                
                signals[key] = signal_info
            
            return {
                'message_name': message.name,
                'signals': signals
            }
        except KeyError as e:
            print(f"[DECODE] Message not found in DBC: can_id=0x{can_id:X}, is_extended={is_extended}, error={e}")
            return None
        except Exception as e:
            print(f"[DECODE] Decode error: can_id=0x{can_id:X}, error={e}")
            return None
    
    def _on_message_received(self, msg):
        """Callback for received CAN messages - broadcasts to all WebSocket clients
        
        This is called from the driver's receive thread, so we need to schedule
        the async broadcast on the main event loop.
        """
        self.message_count += 1
        
        # Convert message to JSON-serializable format
        message_data = {
            'id': msg.id,
            'data': list(msg.data),
            'timestamp': msg.timestamp,
            'is_extended': msg.is_extended,
            'is_remote': msg.is_remote,
            'dlc': msg.dlc
        }
        
        # Debug: Print first few messages
        if self.message_count <= 5:
            print(f"[RX] Message #{self.message_count}: ID=0x{msg.id:X}, Extended={msg.is_extended}, DLC={msg.dlc}, Data={msg.data.hex()}")
        
        # Check for server-decoded data (Network driver with DBC loaded on server)
        if hasattr(msg, 'server_decoded') and msg.server_decoded:
            # Use server-decoded data - convert signals list to dict format
            server_decoded = msg.server_decoded
            if server_decoded.get('message_name') or server_decoded.get('signals'):
                signals = {}
                if server_decoded.get('signals'):
                    for sig in server_decoded['signals']:
                        if isinstance(sig, dict):
                            sig_name = sig.get('name', 'unknown')
                            # Preserve full signal info including value, unit, and any other metadata
                            signal_info = {
                                'value': sig.get('value', 0)
                            }
                            # Add unit if present
                            if sig.get('unit'):
                                signal_info['unit'] = sig['unit']
                            # Add raw value if present (for enum values)
                            if 'raw' in sig:
                                signal_info['raw'] = sig['raw']
                            signals[sig_name] = signal_info
                
                message_data['decoded'] = {
                    'message_name': server_decoded.get('message_name'),
                    'signals': signals
                }
                if self.message_count <= 5:
                    print(f"[RX] Server-decoded: {server_decoded.get('message_name')}")
        # Fallback to local DBC decoding if no server-decoded data
        elif self.dbc_database:
            decoded = self.decode_message(msg.id, msg.data, msg.is_extended)
            if decoded:
                message_data['decoded'] = decoded
        else:
            if self.message_count <= 2:
                print(f"[RX] No DBC database available for decoding")
        
        # Schedule broadcast on the event loop (if available)
        if self.loop and self.loop.is_running():
            if self.message_count <= 5:
                print(f"[RX] Broadcasting to {len(self.active_connections)} clients, loop running: {self.loop.is_running()}")
            asyncio.run_coroutine_threadsafe(
                self.broadcast_message(message_data),
                self.loop
            )
        else:
            if self.message_count <= 5:
                print(f"[RX] NOT broadcasting - loop={self.loop}, running={self.loop.is_running() if self.loop else 'N/A'}")
    
    async def broadcast_message(self, message: dict):
        """Broadcast message to all connected WebSocket clients"""
        disconnected = []
        
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception as e:
                print(f"Error broadcasting to client: {e}")
                disconnected.append(connection)
        
        # Remove disconnected clients
        for connection in disconnected:
            if connection in self.active_connections:
                self.active_connections.remove(connection)
    
    async def add_websocket_connection(self, websocket: WebSocket):
        """Add a WebSocket connection"""
        await websocket.accept()
        self.active_connections.append(websocket)
        print(f"[WS] WebSocket connected, total clients: {len(self.active_connections)}")
    
    def remove_websocket_connection(self, websocket: WebSocket):
        """Remove a WebSocket connection"""
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            print(f"[WS] WebSocket disconnected, remaining clients: {len(self.active_connections)}")


# ============================================================================
# FastAPI Application
# ============================================================================

app = FastAPI(
    title="CAN Communication Backend",
    description="REST API and WebSocket interface for CAN bus communication",
    version="1.0.0"
)

# CORS middleware for web frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure this for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global backend instance
backend = CANBackend()


def cleanup_on_exit():
    """Cleanup handler called on program exit."""
    print("\n[Cleanup] Performing cleanup on exit...")
    if backend.is_connected:
        try:
            if backend.driver and hasattr(backend.driver, 'stop_receive_thread'):
                backend.driver.stop_receive_thread()
            backend.disconnect()
            print("[Cleanup] Disconnected successfully")
        except Exception as e:
            print(f"[Cleanup] Error during disconnect: {e}")


# Register cleanup handler
atexit.register(cleanup_on_exit)


# ============================================================================
# REST API Endpoints
# ============================================================================

@app.get("/")
async def root():
    """API root endpoint"""
    return {
        "name": "CAN Communication Backend",
        "version": "1.0.0",
        "pcan_available": PCAN_AVAILABLE,
        "canable_available": CANABLE_AVAILABLE,
        "dbc_support": DBC_SUPPORT
    }


@app.get("/devices", response_model=DeviceListResponse)
async def get_devices():
    """Get list of available CAN devices"""
    devices = backend.get_available_devices()
    return DeviceListResponse(
        pcan_available=PCAN_AVAILABLE,
        canable_available=CANABLE_AVAILABLE,
        devices=devices
    )


@app.post("/connect", response_model=ConnectionResponse)
async def connect(request: ConnectionRequest):
    """Connect to a CAN device"""
    if backend.is_connected:
        raise HTTPException(status_code=400, detail="Already connected. Disconnect first.")
    
    success = backend.connect(request.device_type, request.channel, request.baudrate)
    
    if success:
        await backend.broadcast_connection_status('connected', 'connected_via_api')
        return ConnectionResponse(
            success=True,
            message="Connected successfully",
            device_type=request.device_type.value,
            channel=request.channel,
            baudrate=request.baudrate
        )
    else:
        detail = backend.connection_reason or "Failed to connect to device"
        raise HTTPException(status_code=500, detail=detail)


@app.post("/disconnect", response_model=DisconnectionResponse)
async def disconnect():
    """Disconnect from CAN device"""
    if backend.is_simulation_active():
        await backend.stop_simulation()
        await backend.broadcast_connection_status('disconnected', 'simulation_stopped')
        return DisconnectionResponse(success=True, message="Simulation stopped")

    if not backend.is_connected:
        raise HTTPException(status_code=400, detail="Not connected to any device")
    
    success = backend.disconnect()
    
    if success:
        await backend.broadcast_connection_status('disconnected', 'disconnected_via_api')
        return DisconnectionResponse(success=True, message="Disconnected successfully")
    else:
        raise HTTPException(status_code=500, detail="Failed to disconnect")


@app.get("/status", response_model=BusStatusResponse)
async def get_status():
    """Get current bus status"""
    status = backend.get_bus_status()
    return BusStatusResponse(**status)


@app.get("/health")
async def get_health():
    """Get backend connection health state for wake/sleep recovery UX."""
    return backend.get_connection_health()


@app.post("/shutdown")
async def shutdown_backend():
    """Gracefully disconnect hardware so launcher can terminate process safely."""
    await backend.shutdown()
    return {"success": True, "message": "Backend shutdown cleanup complete"}


@app.post("/send", response_model=CANMessageResponse)
async def send_message(request: CANMessageRequest):
    """Send a CAN message"""
    if not backend.is_connected:
        raise HTTPException(status_code=400, detail="Not connected to any device")
    
    success = backend.send_message(
        request.can_id,
        request.data,
        request.is_extended,
        request.is_remote
    )
    
    if success:
        return CANMessageResponse(success=True, message="Message sent successfully")
    else:
        raise HTTPException(status_code=500, detail="Failed to send message")


@app.post("/dbc/upload", response_model=DBCLoadResponse)
async def upload_dbc(file: UploadFile = File(...)):
    """Upload and load a DBC file"""
    if not DBC_SUPPORT:
        raise HTTPException(status_code=400, detail="DBC support not available (install cantools)")
    
    # Validate file extension
    if not file.filename.endswith('.dbc'):
        raise HTTPException(status_code=400, detail="File must have .dbc extension")
    
    try:
        # Save the uploaded file
        file_path = DBC_DIR / file.filename
        with open(file_path, 'wb') as f:
            shutil.copyfileobj(file.file, f)
        
        # Load the DBC file
        success = backend.load_dbc_file(str(file_path))
        
        if success:
            # Save as last loaded file
            with open(LAST_DBC_FILE, 'w') as f:
                f.write(file.filename)
            
            message_count = len(backend.dbc_database.messages) if backend.dbc_database else 0
            return DBCLoadResponse(
                success=True,
                message=f"DBC file '{file.filename}' uploaded and loaded successfully",
                file_path=str(file_path),
                message_count=message_count
            )
        else:
            raise HTTPException(status_code=500, detail="Failed to load DBC file")
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error uploading file: {str(e)}")


@app.get("/dbc/current")
async def get_current_dbc():
    """Get information about currently loaded DBC file"""
    if not backend.dbc_database:
        return {
            "loaded": False,
            "filename": None,
            "message_count": 0
        }
    
    # Try to get filename from last loaded
    filename = "Unknown"
    if LAST_DBC_FILE.exists():
        with open(LAST_DBC_FILE, 'r') as f:
            filename = f.read().strip()
    
    return {
        "loaded": True,
        "filename": filename,
        "message_count": len(backend.dbc_database.messages)
    }


@app.get("/dbc/list")
async def list_dbc_files():
    """List all uploaded DBC files"""
    files = []
    for file_path in DBC_DIR.glob("*.dbc"):
        files.append({
            "filename": file_path.name,
            "size": file_path.stat().st_size,
            "modified": file_path.stat().st_mtime
        })
    return {"files": files}


@app.delete("/dbc/delete/{filename}")
async def delete_dbc_file(filename: str):
    """Delete a DBC file"""
    # Validate filename to prevent path traversal
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    
    file_path = DBC_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    
    try:
        file_path.unlink()
        
        # Clear last loaded if this was the last file
        if LAST_DBC_FILE.exists():
            with open(LAST_DBC_FILE, 'r') as f:
                last_filename = f.read().strip()
            if last_filename == filename:
                LAST_DBC_FILE.unlink()
                backend.dbc_database = None
        
        return {"success": True, "message": f"File '{filename}' deleted"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error deleting file: {str(e)}")


@app.post("/dbc/load", response_model=DBCLoadResponse)
async def load_dbc(request: DBCLoadRequest):
    """Load a DBC file (legacy endpoint for backward compatibility)"""
    if not DBC_SUPPORT:
        raise HTTPException(status_code=400, detail="DBC support not available (install cantools)")
    
    if not os.path.exists(request.file_path):
        raise HTTPException(status_code=404, detail="DBC file not found")
    
    success = backend.load_dbc_file(request.file_path)
    
    if success:
        message_count = len(backend.dbc_database.messages) if backend.dbc_database else 0
        return DBCLoadResponse(
            success=True,
            message="DBC file loaded successfully",
            file_path=request.file_path,
            message_count=message_count
        )
    else:
        raise HTTPException(status_code=500, detail="Failed to load DBC file")


@app.get("/dbc/messages", response_model=DBCMessagesResponse)
async def get_dbc_messages():
    """Get list of messages from loaded DBC file"""
    if not backend.dbc_database:
        raise HTTPException(status_code=400, detail="No DBC file loaded")
    
    messages = backend.get_dbc_messages()
    return DBCMessagesResponse(success=True, messages=messages)


@app.get("/stats")
async def get_stats():
    """Get message statistics"""
    if not backend.is_connected:
        return {
            "connected": False,
            "message_count": 0,
            "uptime_seconds": 0,
            "message_rate": 0
        }
    
    uptime = (datetime.now() - backend.start_time).total_seconds() if backend.start_time else 0
    message_rate = backend.message_count / uptime if uptime > 0 else 0
    
    return {
        "connected": True,
        "message_count": backend.message_count,
        "uptime_seconds": uptime,
        "message_rate": round(message_rate, 2)
    }


@app.post("/simulation/start")
async def start_simulation():
    """Start fake BMS telemetry stream for UI testing."""
    success = await backend.start_simulation()
    if not success:
        raise HTTPException(status_code=400, detail="Unable to start simulation (real device may be connected or DBC unavailable)")

    await backend.broadcast_connection_status('connected', 'simulation_started')
    return {"success": True, "message": "Simulation started"}


@app.post("/simulation/stop")
async def stop_simulation():
    """Stop fake BMS telemetry stream."""
    success = await backend.stop_simulation()
    if not success:
        raise HTTPException(status_code=500, detail="Failed to stop simulation")

    await backend.broadcast_connection_status('disconnected', 'simulation_stopped')
    return {"success": True, "message": "Simulation stopped"}


@app.get("/simulation/status")
async def simulation_status():
    """Get current simulation mode status."""
    return {
        "active": backend.is_simulation_active()
    }


# ============================================================================
# Transmit List Endpoints
# ============================================================================

@app.post("/transmit_list/save")
async def save_transmit_list(request: SaveTransmitListRequest):
    """Save transmit list for a specific DBC file"""
    try:
        # Sanitize DBC filename for use as JSON filename
        dbc_filename = Path(request.dbc_file).stem
        json_filename = f"{dbc_filename}_transmit_list.json"
        json_path = TRANSMIT_LISTS_DIR / json_filename
        
        # Convert items to dict for JSON serialization
        items_data = [item.dict() for item in request.items]
        
        # Save to JSON file
        with open(json_path, 'w') as f:
            json.dump({
                "dbc_file": request.dbc_file,
                "items": items_data
            }, f, indent=2)
        
        return {
            "success": True,
            "message": f"Transmit list saved for {request.dbc_file}",
            "file_path": str(json_path)
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save transmit list: {str(e)}")


@app.get("/transmit_list/load", response_model=TransmitListResponse)
async def load_transmit_list(dbc_file: str):
    """Load transmit list for a specific DBC file"""
    try:
        # Sanitize DBC filename for use as JSON filename
        dbc_filename = Path(dbc_file).stem
        json_filename = f"{dbc_filename}_transmit_list.json"
        json_path = TRANSMIT_LISTS_DIR / json_filename
        
        if not json_path.exists():
            return TransmitListResponse(
                success=True,
                items=[],
                dbc_file=dbc_file
            )
        
        # Load from JSON file
        with open(json_path, 'r') as f:
            data = json.load(f)
        
        items = [TransmitListItem(**item) for item in data.get("items", [])]
        
        return TransmitListResponse(
            success=True,
            items=items,
            dbc_file=data.get("dbc_file", dbc_file)
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load transmit list: {str(e)}")


@app.post("/dbc/encode_message")
async def encode_message(message_name: str, signals: str):
    """Encode a DBC message with signal values into raw bytes"""
    if not DBC_SUPPORT:
        raise HTTPException(status_code=501, detail="DBC support not available (cantools not installed)")
    
    if not backend.dbc_database:
        raise HTTPException(status_code=400, detail="No DBC file loaded")
    
    try:
        # Parse signals from JSON string
        import json
        signals_dict = json.loads(signals)
        
        # Find the message in the DBC database
        message = backend.dbc_database.get_message_by_name(message_name)
        
        # Encode the message with the provided signal values
        data = message.encode(signals_dict)
        
        # Check if it's an extended ID and extract the actual ID
        is_extended = message.frame_id > 0x7FF
        actual_id = message.frame_id & 0x1FFFFFFF if is_extended else message.frame_id
        
        return {
            "success": True,
            "message_name": message_name,
            "can_id": actual_id,
            "is_extended": is_extended,
            "data": list(data),
            "length": len(data)
        }
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Message '{message_name}' not found in DBC file")
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"Invalid signals JSON: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to encode message: {str(e)}")


@app.post("/flash_firmware", response_model=FirmwareFlashResponse)
async def flash_firmware(file: UploadFile = File(...), module_number: int = Form(0)):
    """Flash firmware to a BMS module"""
    print(f"[FLASH] Starting firmware flash for module {module_number}, file: {file.filename}")
    
    if not FIRMWARE_FLASHER_AVAILABLE:
        raise HTTPException(status_code=501, detail="Firmware flasher not available")
    
    if not backend.is_connected:
        raise HTTPException(status_code=400, detail="CAN bus not connected")
    
    if not backend.driver:
        raise HTTPException(status_code=500, detail="No CAN driver available")
    
    # Validate module number (0-5 for TREV BMS)
    if not 0 <= module_number <= 5:
        raise HTTPException(status_code=400, detail="Module number must be between 0 and 5")
    
    # Validate file is .bin
    if not file.filename.endswith('.bin'):
        raise HTTPException(status_code=400, detail="File must be a .bin firmware file")
    
    try:
        # Save uploaded file temporarily
        temp_dir = Path(__file__).parent / "temp"
        temp_dir.mkdir(exist_ok=True)
        temp_file_path = temp_dir / file.filename
        
        print(f"[FLASH] Saving file to {temp_file_path}")
        with open(temp_file_path, 'wb') as buffer:
            shutil.copyfileobj(file.file, buffer)
        
        file_size = temp_file_path.stat().st_size
        print(f"[FLASH] File saved, size: {file_size} bytes")
        
        # Create firmware flasher with progress callback
        def progress_callback(progress):
            # TODO: Send progress updates via WebSocket
            print(f"[FLASH] Progress: {progress.stage} - {progress.progress}% - {progress.message}")
        
        print(f"[FLASH] Creating FirmwareFlasher instance")
        flasher = FirmwareFlasher(backend.driver, progress_callback)
        
        print(f"[FLASH] Starting flash_firmware() call")
        # Flash the firmware (with verify and jump to application)
        # Pass Path object, not string
        success = flasher.flash_firmware(
            firmware_path=temp_file_path,  # Pass Path object directly
            module_number=module_number,
            verify=True,
            jump=True
        )
        
        if not success:
            print(f"[FLASH] Flash failed - flasher returned False")
            raise Exception("Firmware flash operation failed")
        
        print(f"[FLASH] Flash completed successfully")
        # Clean up temp file
        temp_file_path.unlink(missing_ok=True)
        
        return FirmwareFlashResponse(
            success=True,
            message=f"Firmware successfully flashed to module {module_number}"
        )
        
    except FileNotFoundError as e:
        # Clean up temp file on error
        if 'temp_file_path' in locals():
            temp_file_path.unlink(missing_ok=True)
        raise HTTPException(status_code=404, detail=f"Firmware file not found: {str(e)}")
    except Exception as e:
        # Clean up temp file on error
        if 'temp_file_path' in locals():
            temp_file_path.unlink(missing_ok=True)
        
        # Log the full error for debugging
        import traceback
        print(f"Firmware flash error: {str(e)}")
        print(traceback.format_exc())
        
        raise HTTPException(status_code=500, detail=f"Firmware flash failed: {str(e)}")


# ============================================================================
# WebSocket Endpoint for Real-time CAN Messages
# ============================================================================

@app.websocket("/ws/can")
async def websocket_can_messages(websocket: WebSocket):
    """WebSocket endpoint for real-time CAN message streaming"""
    # Store the current event loop so the receive thread can schedule async tasks
    if backend.loop is None:
        backend.loop = asyncio.get_event_loop()
    
    await backend.add_websocket_connection(websocket)
    
    try:
        while True:
            # Keep connection alive and handle any client messages
            data = await websocket.receive_text()
            # Echo back for heartbeat
            await websocket.send_json({"type": "heartbeat", "timestamp": datetime.now().isoformat()})
    except WebSocketDisconnect:
        backend.remove_websocket_connection(websocket)
        print("WebSocket client disconnected")
    except Exception as e:
        print(f"WebSocket error: {e}")
        backend.remove_websocket_connection(websocket)


# ============================================================================
# Application Lifecycle
# ============================================================================

@app.on_event("startup")
async def startup_event():
    """Startup event handler"""
    print("=" * 60)
    print("CAN Communication Backend Starting")
    print("=" * 60)
    print(f"PCAN Available: {PCAN_AVAILABLE}")
    print(f"CANable Available: {CANABLE_AVAILABLE}")
    print(f"DBC Support: {DBC_SUPPORT}")
    print("=" * 60)
    
    # Set the event loop for the backend so messages can be broadcast
    # even before the first WebSocket connection
    backend.loop = asyncio.get_running_loop()
    print("[OK] Event loop initialized for CAN message broadcasting")
    backend.start_health_monitor()
    
    # Auto-load last DBC file if it exists
    if DBC_SUPPORT and LAST_DBC_FILE.exists():
        try:
            with open(LAST_DBC_FILE, 'r') as f:
                last_filename = f.read().strip()
            
            dbc_path = DBC_DIR / last_filename
            if dbc_path.exists():
                if backend.load_dbc_file(str(dbc_path)):
                    msg_count = len(backend.dbc_database.messages) if backend.dbc_database else 0
                    print(f"[OK] Auto-loaded DBC file: {last_filename} ({msg_count} messages)")
                else:
                    print(f"[ERROR] Failed to auto-load DBC file: {last_filename}")
            else:
                print(f"[INFO] Last DBC file not found: {last_filename}")
        except Exception as e:
            print(f"[ERROR] Error auto-loading DBC file: {e}")
    
    print("=" * 60)


@app.on_event("shutdown")
async def shutdown_event():
    """Shutdown event handler - ensures clean disconnection"""
    print("\n" + "=" * 60)
    print("SHUTTING DOWN SERVER")
    print("=" * 60)
    
    await backend.shutdown()
    
    print("[Shutdown] Backend stopped")
    print("=" * 60)


# ============================================================================
# Main Entry Point
# ============================================================================

def main():
    """Run the backend server"""
    # Note: reload=False for stability when launched from start.py
    # For development, run directly: python api.py --reload
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--reload', action='store_true', help='Enable auto-reload for development')
    args = parser.parse_args()
    
    uvicorn.run(
        "api:app",
        host="0.0.0.0",
        port=8000,
        reload=args.reload,
        log_level="info"
    )


if __name__ == "__main__":
    main()
