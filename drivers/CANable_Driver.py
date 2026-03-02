"""
CANable Driver Module
=====================
A Python object-oriented driver for CANable USB-to-CAN adapters.
This module provides a high-level interface to interact with CANable devices.

The CANable is a low-cost, open-source USB-to-CAN adapter using candleLight 
firmware. This driver uses the Candle API (gs_usb) for direct USB communication 
via libusb, providing better performance than SLCAN.

Requires: libusb-1.0.dll (Windows) or libusb-1.0 (Linux/Mac)

Author: GitHub Copilot
Date: October 10, 2025
"""

from enum import Enum
from dataclasses import dataclass
from typing import Optional, List, Callable
import time
import threading
import os
import sys
import asyncio
import inspect

# CRITICAL: Setup libusb backend BEFORE importing python-can
# This is required on Windows for gs_usb to find devices
if sys.platform == 'win32':
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_dir = os.path.dirname(script_dir)
    libusb_path = os.path.join(project_dir, 'libusb-1.0.dll')
    
    if os.path.exists(libusb_path):
        # Add to PATH first
        os.environ['PATH'] = project_dir + os.pathsep + os.environ.get('PATH', '')
        
        # Force pyusb to use our libusb DLL
        try:
            import usb.backend.libusb1
            import usb.core
            _libusb_backend = usb.backend.libusb1.get_backend(
                find_library=lambda x: libusb_path
            )
            # Force this backend to be used globally
            usb.core._BACKENDS = [_libusb_backend]
            print(f"[OK] Forced libusb backend: {libusb_path}")
        except Exception as e:
            print(f"[WARN] Could not force libusb backend: {e}")


try:
    from can import Bus, Message
except ImportError:
    print("Error: python-can library not found. Install with: pip install python-can")
    raise

try:
    import usb.core
    import usb.util
except ImportError:
    print("Warning: pyusb library not found. Install with: pip install pyusb")
    print("         This is required for USB device enumeration.")
    usb = None


class CANableBaudRate(Enum):
    """Standard CAN baud rates for CANable"""
    BAUD_1M = 1000000
    BAUD_800K = 800000
    BAUD_500K = 500000
    BAUD_250K = 250000
    BAUD_125K = 125000
    BAUD_100K = 100000
    BAUD_50K = 50000
    BAUD_20K = 20000
    BAUD_10K = 10000


# USB Vendor/Product IDs for CANable devices with candleLight firmware
CANABLE_USB_VID = 0x1D50  # OpenMoko vendor ID
CANABLE_USB_PID = 0x606F  # candleLight product ID

# Alternative IDs for other gs_usb compatible devices
GS_USB_DEVICES = [
    (0x1D50, 0x606F),  # CANable (candleLight)
    (0x1209, 0x0001),  # CANtact/CANable (older)
    (0x16D0, 0x0F67),  # candleLight
]


@dataclass
class CANMessage:
    """
    Represents a CAN message with all relevant information.
    """
    id: int
    data: bytes
    timestamp: float = 0.0
    is_extended: bool = False
    is_remote: bool = False
    is_error: bool = False
    is_fd: bool = False
    dlc: int = 0
    
    def __post_init__(self):
        if self.dlc == 0:
            self.dlc = len(self.data)
    
    def __str__(self):
        msg_type = "EXT" if self.is_extended else "STD"
        data_str = ' '.join([f'{b:02X}' for b in self.data])
        return f"ID: 0x{self.id:X} [{msg_type}] DLC: {self.dlc} Data: [{data_str}]"


class CANableDriver:
    """
    Object-oriented driver for CANable USB-to-CAN adapters using Candle API.
    
    This class provides a high-level interface to:
    - Initialize and connect to CANable devices via USB (gs_usb/Candle API)
    - Send and receive CAN messages
    - Configure CAN parameters
    - Monitor bus status
    - Handle errors
    
    Uses the gs_usb interface from python-can for direct USB communication,
    which is faster and more reliable than SLCAN.
    
    Example:
        >>> driver = CANableDriver()
        >>> devices = driver.get_available_devices()
        >>> driver.connect(0, CANableBaudRate.BAUD_500K)  # Connect to first device
        >>> driver.send_message(0x123, b'\\x01\\x02\\x03\\x04')
        >>> msg = driver.read_message()
        >>> driver.disconnect()
    """
    
    def __init__(self):
        """Initialize the CANable driver."""
        self._bus: Optional[Bus] = None
        self._channel: Optional[int] = None  # Now an integer index
        self._baudrate: Optional[CANableBaudRate] = None
        self._is_connected: bool = False
        self._receive_thread: Optional[threading.Thread] = None
        self._receive_callback: Optional[Callable[[CANMessage], None]] = None
        self._stop_receive: bool = False
        self._device_info: Optional[dict] = None
        self._fd_mode: bool = False
        self._hardware_lost: bool = False
        
        # Ensure libusb DLL is accessible on Windows
        self._setup_libusb_path()
    
    def _setup_libusb_path(self):
        """Setup libusb DLL path for Windows."""
        if sys.platform == 'win32':
            # Add current directory to DLL search path for libusb-1.0.dll
            script_dir = os.path.dirname(os.path.abspath(__file__))
            project_dir = os.path.dirname(script_dir)
            
            # Check if libusb-1.0.dll exists in project directory
            libusb_path = os.path.join(project_dir, 'libusb-1.0.dll')
            if os.path.exists(libusb_path):
                # Add to PATH
                os.environ['PATH'] = project_dir + os.pathsep + os.environ.get('PATH', '')
                print(f"[OK] Found libusb-1.0.dll at {libusb_path}")
                
                # Setup explicit libusb backend for Windows to work around gs_usb issues
                try:
                    import usb.core
                    import usb.backend.libusb1
                    self._libusb_backend = usb.backend.libusb1.get_backend(
                        find_library=lambda x: libusb_path
                    )
                    print(f"[OK] Configured explicit libusb backend")
                except Exception as e:
                    print(f"[WARN] Could not setup explicit backend: {e}")
                    self._libusb_backend = None
            else:
                print(f"[WARN] Warning: libusb-1.0.dll not found at {libusb_path}")
                print("  The driver may fail to connect without libusb-1.0.dll")
                self._libusb_backend = None
        else:
            self._libusb_backend = None
        
    def get_available_devices(self) -> List[dict]:
        """
        Scan for available CANable devices using USB enumeration.
        
        Returns:
            List of dictionaries containing device information.
            Each device has: index, vid, pid, manufacturer, product, serial, bus, address
        """
        available_devices = []
        
        if usb is None:
            print("[WARN] pyusb not available, cannot enumerate USB devices")
            print("  Install with: pip install pyusb")
            return available_devices
        
        try:
            # Use explicit backend if available (Windows fix)
            backend = getattr(self, '_libusb_backend', None)
            
            # Find all gs_usb compatible devices
            device_index = 0
            for vid, pid in GS_USB_DEVICES:
                devices = usb.core.find(find_all=True, backend=backend, idVendor=vid, idProduct=pid)
                
                for dev in devices:
                    try:
                        # Get device information
                        manufacturer = usb.util.get_string(dev, dev.iManufacturer) if dev.iManufacturer else "Unknown"
                        product = usb.util.get_string(dev, dev.iProduct) if dev.iProduct else "Unknown"
                        serial = usb.util.get_string(dev, dev.iSerialNumber) if dev.iSerialNumber else "Unknown"
                    except:
                        manufacturer = "Unknown"
                        product = "Unknown"
                        serial = "Unknown"
                    
                    device_info = {
                        'index': device_index,
                        'vid': vid,
                        'pid': pid,
                        'manufacturer': manufacturer,
                        'product': product,
                        'serial_number': serial,
                        'bus': dev.bus,
                        'address': dev.address,
                        'description': f"{manufacturer} {product}",
                        'channel': f"can{device_index}",  # gs_usb uses can0, can1, etc.
                        '_usb_device': dev  # Store reference for direct connection
                    }
                    
                    available_devices.append(device_info)
                    device_index += 1
            
            if not available_devices:
                print("ℹ No CANable/gs_usb devices found")
                print("  Make sure:")
                print("  1. CANable is connected via USB")
                print("  2. Device has candleLight firmware (gs_usb compatible)")
                print("  3. On Windows: libusb-1.0.dll is in the project directory")
                print("  4. On Linux: You have permissions (try: sudo usermod -a -G plugdev $USER)")
            
        except Exception as e:
            print(f"Error scanning for USB devices: {e}")
        
        return available_devices
    
    def _force_cleanup(self):
        """Force cleanup of any lingering resources. Internal use only."""
        try:
            if self._bus:
                try:
                    self._bus.shutdown()
                except:
                    pass
                self._bus = None
            
            import gc
            gc.collect()
            time.sleep(0.5)
        except:
            pass
    
    def connect(self, channel: int, baudrate: CANableBaudRate, 
                fd_mode: bool = False) -> bool:
        """
        Connect to a CANable device using gs_usb/Candle API.
        
        Args:
            channel: Device index (0 for first device, 1 for second, etc.)
                    Use get_available_devices() to see available indices.
            baudrate: CAN bus baudrate (e.g., CANableBaudRate.BAUD_500K)
            fd_mode: Enable CAN FD mode (default: False) - may not be supported
        
        Returns:
            True if connection successful, False otherwise.
        """
        if self._is_connected:
            print("Already connected to a CANable device. Disconnect first.")
            return False
        
        # Ensure any previous connection is fully cleaned up
        self._force_cleanup()
        
        try:
            # Get bitrate value
            bitrate = baudrate.value
            
            # Try to connect - no retries to avoid locking issues
            try:
                # Create bus instance using gs_usb interface (Candle API)
                # This provides direct USB access to CANable with candleLight firmware
                # IMPORTANT: Must use 'index' parameter for device selection!
                self._bus = Bus(
                    interface='gs_usb',
                    channel=channel,  # Still needed for python-can
                    index=channel,    # THIS IS CRITICAL - index parameter for device selection
                    bitrate=bitrate,
                    fd=fd_mode,
                    data_bitrate=bitrate if fd_mode else None
                )
            except Exception as e:
                raise
            
            self._channel = channel
            self._baudrate = baudrate
            self._fd_mode = fd_mode
            self._is_connected = True
            self._hardware_lost = False
            
            # Try to get device info
            devices = self.get_available_devices()
            if channel < len(devices):
                self._device_info = devices[channel]
                device_desc = self._device_info.get('description', 'Unknown')
            else:
                device_desc = f"Device {channel}"
            
            print(f"[OK] Connected to {device_desc} (channel {channel}) at {bitrate} bps")
            print(f"  Using Candle API (gs_usb) via libusb")
            return True
            
        except Exception as e:
            print(f"[ERROR] Failed to connect: {str(e)}")
            print(f"\n  Troubleshooting:")
            print(f"  1. Verify CANable is connected and has candleLight firmware")
            print(f"  2. Check available devices with get_available_devices()")
            print(f"  3. On Windows: Ensure WinUSB driver is installed (use Zadig)")
            print(f"  4. Try unplugging and replugging the CANable")
            print(f"  5. On Linux: Check permissions (sudo usermod -a -G plugdev $USER)")
            return False
    
    def disconnect(self) -> bool:
        """
        Disconnect from the CANable device.
        
        Returns:
            True if disconnection successful, False otherwise.
        """
        if not self._is_connected:
            print("Not connected to any CANable device.")
            return False
        
        try:
            # First, set flag to signal we're disconnecting
            self._is_connected = False
            
            # Stop receive thread if running (this sets _stop_receive = True)
            self.stop_receive_thread()
            
            # Give extra time for thread to fully stop and release resources
            time.sleep(0.1)
            
            # Now safely shutdown bus
            if self._bus:
                try:
                    # Workaround for python-can gs_usb double-shutdown bug
                    # We need to manually close the USB device and prevent the destructor from trying again
                    
                    # First, try to stop the device and close USB handle
                    if hasattr(self._bus, 'gs_usb') and self._bus.gs_usb:
                        try:
                            # Stop the device
                            if hasattr(self._bus.gs_usb, 'stop'):
                                self._bus.gs_usb.stop()
                            
                            # Close the USB device handle
                            if hasattr(self._bus.gs_usb, 'gs_usb'):
                                usb_dev = self._bus.gs_usb.gs_usb
                                if hasattr(usb_dev, '_ctx') and usb_dev._ctx:
                                    try:
                                        if hasattr(usb_dev._ctx, 'managed_close'):
                                            usb_dev._ctx.managed_close()
                                        elif hasattr(usb_dev._ctx, 'handle'):
                                            usb_dev._ctx.handle = None
                                    except:
                                        pass
                                
                                # Mark as already closed
                                if hasattr(usb_dev, '_ctx'):
                                    usb_dev._ctx = None
                        except Exception as e:
                            # Ignore errors - we're shutting down anyway
                            pass
                    
                    # Now call regular shutdown (which might fail but that's okay)
                    try:
                        self._bus.shutdown()
                    except:
                        pass  # Ignore shutdown errors
                    
                    print("[OK] Bus shutdown complete")
                    
                except Exception as e:
                    # Ignore all shutdown errors - we're cleaning up anyway
                    print(f"[NOTE] {str(e)}")
                finally:
                    self._bus = None
                    
                    # Force garbage collection to ensure all references are released
                    import gc
                    gc.collect()
            
            # Additional delay to ensure USB device is fully released by OS/libusb
            # This is critical for gs_usb/libusb to properly release the device
            # Windows can be slow to release USB handles
            time.sleep(0.2)
            
            self._channel = None
            self._baudrate = None
            self._fd_mode = False
            self._device_info = None
            
            print("[OK] Disconnected from CANable device")
            return True
            
        except Exception as e:
            print(f"[ERROR] Failed to disconnect: {str(e)}")
            # Even if there's an error, try to clean up
            self._is_connected = False
            self._bus = None
            self._channel = None
            self._baudrate = None
            self._fd_mode = False
            self._device_info = None
            
            # Force cleanup even on error
            import gc
            gc.collect()
            time.sleep(0.2)
            
            return False
    
    def send_message(self, can_id: int, data: bytes, 
                    is_extended: bool = False, 
                    is_remote: bool = False) -> bool:
        """
        Send a CAN message.
        
        Args:
            can_id: CAN identifier (11-bit for standard, 29-bit for extended)
            data: Message data (up to 8 bytes for CAN 2.0)
            is_extended: Use extended 29-bit identifier (default: False)
            is_remote: Send as remote frame (default: False)
        
        Returns:
            True if message sent successfully, False otherwise.
        """
        if not self._is_connected or self._bus is None:
            print("[ERROR] Not connected to CANable device")
            return False
        
        try:
            msg = Message(
                arbitration_id=can_id,
                data=data,
                is_extended_id=is_extended,
                is_remote_frame=is_remote
            )
            
            self._bus.send(msg)
            return True
            
        except Exception as e:
            # Only print error if we're still supposed to be connected
            if self._is_connected:
                print(f"[ERROR] Failed to send message: {str(e)}")
                self._hardware_lost = True
            return False
    
    def read_message(self, timeout: float = 1.0) -> Optional[CANMessage]:
        """
        Read a CAN message from the bus.
        
        Args:
            timeout: Timeout in seconds (default: 1.0)
        
        Returns:
            CANMessage object if message received, None otherwise.
        """
        if not self._is_connected or self._bus is None:
            return None
        
        try:
            msg = self._bus.recv(timeout=timeout)
            
            if msg is None:
                return None
            
            return CANMessage(
                id=msg.arbitration_id,
                data=bytes(msg.data),
                timestamp=msg.timestamp,
                is_extended=msg.is_extended_id,
                is_remote=msg.is_remote_frame,
                is_error=msg.is_error_frame,
                is_fd=msg.is_fd,
                dlc=msg.dlc
            )
            
        except Exception as e:
            # Only print error if we're still supposed to be connected
            if self._is_connected:
                print(f"[ERROR] Failed to read message: {str(e)}")
                self._hardware_lost = True
            return None
    
    def start_receive_thread(self, callback: Callable[[CANMessage], None]) -> bool:
        """
        Start a background thread to continuously receive messages.
        
        Args:
            callback: Function to call when a message is received.
                     Should accept a CANMessage parameter.
        
        Returns:
            True if thread started successfully, False otherwise.
        """
        if not self._is_connected:
            print("[ERROR] Not connected to CANable device")
            return False
        
        if self._receive_thread and self._receive_thread.is_alive():
            print("[ERROR] Receive thread already running")
            return False
        
        self._receive_callback = callback
        self._stop_receive = False
        self._receive_thread = threading.Thread(
            target=self._receive_loop,
            daemon=True
        )
        self._receive_thread.start()
        
        print("[OK] Receive thread started")
        return True
    
    def stop_receive_thread(self) -> bool:
        """
        Stop the background receive thread.
        
        Returns:
            True if thread stopped successfully, False otherwise.
        """
        if not self._receive_thread or not self._receive_thread.is_alive():
            return False
        
        self._stop_receive = True
        
        # Wait for thread to finish with extended timeout
        self._receive_thread.join(timeout=3.0)
        
        # Check if thread actually stopped
        if self._receive_thread.is_alive():
            print("[WARN] Warning: Receive thread did not stop cleanly")
        
        self._receive_thread = None
        self._receive_callback = None
        
        print("[OK] Receive thread stopped")
        return True
    
    def _receive_loop(self):
        """Internal method for receiving messages in a loop."""
        error_count = 0
        max_errors = 10  # Allow some errors before giving up
        
        while not self._stop_receive and self._is_connected:
            try:
                msg = self.read_message(timeout=0.1)
                if msg and self._receive_callback:
                    # Reset error count on successful message
                    error_count = 0
                    
                    # Check if callback is async
                    if inspect.iscoroutinefunction(self._receive_callback):
                        # Run async callback in the event loop
                        try:
                            loop = asyncio.get_event_loop()
                            if loop.is_running():
                                asyncio.run_coroutine_threadsafe(
                                    self._receive_callback(msg), 
                                    loop
                                )
                            else:
                                # Fallback: create new event loop
                                asyncio.run(self._receive_callback(msg))
                        except RuntimeError:
                            # No event loop available, create one
                            asyncio.run(self._receive_callback(msg))
                    else:
                        # Synchronous callback
                        try:
                            self._receive_callback(msg)
                        except Exception as cb_error:
                            # Don't let callback errors kill the receive loop
                            error_count += 1
                            if error_count <= 3:
                                print(f"[WARN] Callback error: {str(cb_error)}")
            except Exception as e:
                # Count errors but don't immediately exit
                error_count += 1
                if not self._stop_receive and self._is_connected:
                    if error_count <= 3:
                        print(f"[WARN] Receive loop error ({error_count}): {str(e)}")
                    if error_count >= max_errors:
                        print(f"[ERROR] Too many receive errors, stopping")
                        self._hardware_lost = True
                        break
                else:
                    # We're stopping anyway, exit cleanly
                    break

    def health_check(self) -> bool:
        """Check whether CANable bus handle is still valid."""
        if not self._is_connected or self._bus is None:
            return False

        if self._hardware_lost:
            return False

        try:
            self._bus.recv(timeout=0.0)
            return True
        except Exception as e:
            print(f"[CANable] Health check failed: {e}")
            self._hardware_lost = True
            return False

    def reconnect(self) -> bool:
        """Reconnect using last known channel/baudrate values."""
        if self._channel is None or self._baudrate is None:
            print("[CANable] Cannot reconnect: missing connection parameters")
            return False

        channel = self._channel
        baudrate = self._baudrate
        fd_mode = self._fd_mode

        try:
            self.disconnect()
        except Exception:
            pass

        time.sleep(0.2)
        return self.connect(channel, baudrate, fd_mode=fd_mode)
    
    def get_bus_status(self) -> dict:
        """
        Get the current status of the CAN bus.
        
        Returns:
            Dictionary containing bus status information.
        """
        if not self._is_connected:
            return {'connected': False, 'error': 'Not connected'}
        
        status = {
            'connected': True,
            'channel': self._channel,
            'baudrate': self._baudrate.name if self._baudrate else 'Unknown',
            'interface': 'gs_usb (Candle API)',
            'status': 'OK'
        }
        
        # Add device info if available
        if self._device_info:
            status['device'] = self._device_info.get('description', 'Unknown')
            status['serial'] = self._device_info.get('serial_number', 'Unknown')
        
        return status
    
    def clear_receive_queue(self) -> bool:
        """
        Clear the receive queue.
        
        Returns:
            True if queue cleared successfully, False otherwise.
        """
        if not self._is_connected:
            print("[ERROR] Not connected to CANable device")
            return False
        
        try:
            # Read all pending messages
            count = 0
            while self.read_message(timeout=0.01):
                count += 1
            
            print(f"[OK] Cleared {count} messages from queue")
            return True
            
        except Exception as e:
            print(f"[ERROR] Failed to clear queue: {str(e)}")
            return False
    
    @property
    def is_connected(self) -> bool:
        """Check if connected to a CANable device."""
        return self._is_connected
    
    @property
    def channel(self) -> Optional[int]:
        """Get the current channel (device index)."""
        return self._channel
    
    @property
    def baudrate(self) -> Optional[CANableBaudRate]:
        """Get the current baudrate."""
        return self._baudrate
    
    def __enter__(self):
        """Context manager entry."""
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit - ensures cleanup."""
        self.disconnect()
    
    def __del__(self):
        """Destructor - ensures cleanup."""
        if self._is_connected:
            self.disconnect()


# Example usage and testing
if __name__ == "__main__":
    print("=" * 60)
    print("CANable Driver Test (Candle API / gs_usb)")
    print("=" * 60)
    
    # Create driver instance
    driver = CANableDriver()
    
    # Scan for available devices
    print("\n1. Scanning for CANable devices (USB)...")
    devices = driver.get_available_devices()
    
    if not devices:
        print("[ERROR] No CANable/gs_usb devices found!")
        print("\n  Troubleshooting:")
        print("  1. Make sure your CANable device is connected via USB")
        print("  2. Verify it has candleLight firmware (gs_usb compatible)")
        print("  3. On Windows: Ensure libusb-1.0.dll is in the project directory")
        print("  4. On Linux: Check USB permissions")
        print("     - Add user to plugdev group: sudo usermod -a -G plugdev $USER")
        print("     - Or use udev rules for CANable device")
        print("  5. Install pyusb: pip install pyusb")
        exit(1)
    
    print(f"[OK] Found {len(devices)} CANable/gs_usb device(s):")
    for dev in devices:
        print(f"  [{dev['index']}] {dev['description']}")
        print(f"      VID: 0x{dev['vid']:04X}, PID: 0x{dev['pid']:04X}")
        print(f"      Serial: {dev['serial_number']}")
        print(f"      Channel: {dev['channel']}")
    
    # Connect to first device
    print("\n2. Connecting to device...")
    channel_index = 0  # Use first device
    
    if driver.connect(channel_index, CANableBaudRate.BAUD_500K):
        print(f"[OK] Successfully connected!")
        
        # Get bus status
        print("\n3. Checking bus status...")
        status = driver.get_bus_status()
        print(f"  Interface: {status.get('interface', 'Unknown')}")
        print(f"  Status: {status.get('status', 'Unknown')}")
        print(f"  Baudrate: {status.get('baudrate', 'Unknown')}")
        if 'device' in status:
            print(f"  Device: {status['device']}")
        
        # Example: Send a message
        print("\n4. Sending test message...")
        test_data = bytes([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88])
        if driver.send_message(0x123, test_data):
            print(f"[OK] Message sent: ID=0x123, Data={test_data.hex()}")
        
        # Example: Read messages
        print("\n5. Listening for messages (5 seconds)...")
        print("  (Send some CAN messages to see them here)")
        
        def message_handler(msg: CANMessage):
            print(f"  Received: {msg}")
        
        driver.start_receive_thread(message_handler)
        time.sleep(5)
        driver.stop_receive_thread()
        
        # Disconnect
        print("\n6. Disconnecting...")
        driver.disconnect()
    else:
        print("[ERROR] Failed to connect!")
        print("\nTroubleshooting:")
        print("  - Check that the CANable is properly connected via USB")
        print("  - Verify the device has candleLight firmware (gs_usb compatible)")
        print("  - On Windows: Ensure libusb-1.0.dll is in the project directory")
        print("  - On Linux: You may need USB permissions")
        print("    Try: sudo usermod -a -G plugdev $USER (then logout/login)")
        print("  - Install gs_usb support: pip install python-can[gs_usb]")
    
    print("\n" + "=" * 60)
    print("Test complete!")
    print("=" * 60)
