"""
Utility functions for the backend API
"""

from typing import Optional, Dict, Any
import json
from datetime import datetime


def format_can_id(can_id: int, is_extended: bool = False) -> str:
    """Format CAN ID as hex string"""
    if is_extended:
        return f"0x{can_id:08X}"
    else:
        return f"0x{can_id:03X}"


def parse_can_id(can_id_str: str) -> tuple[int, bool]:
    """Parse CAN ID string and determine if extended
    
    Returns:
        Tuple of (can_id, is_extended)
    """
    can_id_str = can_id_str.strip().upper()
    
    # Remove 0x prefix if present
    if can_id_str.startswith('0X'):
        can_id_str = can_id_str[2:]
    
    can_id = int(can_id_str, 16)
    is_extended = can_id > 0x7FF
    
    return can_id, is_extended


def bytes_to_hex_string(data: bytes, separator: str = ' ') -> str:
    """Convert bytes to hex string"""
    return separator.join([f'{b:02X}' for b in data])


def hex_string_to_bytes(hex_str: str) -> bytes:
    """Convert hex string to bytes"""
    hex_str = hex_str.replace(' ', '').replace(',', '').replace('-', '')
    return bytes.fromhex(hex_str)


def validate_can_data(data: list[int]) -> bool:
    """Validate CAN data bytes"""
    if len(data) > 8:
        return False
    
    for byte in data:
        if not isinstance(byte, int) or byte < 0 or byte > 255:
            return False
    
    return True


def format_timestamp(timestamp: float) -> str:
    """Format timestamp for display"""
    dt = datetime.fromtimestamp(timestamp)
    return dt.strftime("%H:%M:%S.%f")[:-3]


def calculate_message_rate(message_count: int, uptime_seconds: float) -> float:
    """Calculate message rate (messages per second)"""
    if uptime_seconds <= 0:
        return 0.0
    return message_count / uptime_seconds


class ConfigManager:
    """Configuration manager for backend settings"""
    
    def __init__(self, config_file: str = "config.json"):
        self.config_file = config_file
        self.config: Dict[str, Any] = {}
        self.load()
    
    def load(self):
        """Load configuration from file"""
        try:
            with open(self.config_file, 'r') as f:
                self.config = json.load(f)
        except FileNotFoundError:
            self.config = self.get_default_config()
            self.save()
        except Exception as e:
            print(f"Error loading config: {e}")
            self.config = self.get_default_config()
    
    def save(self):
        """Save configuration to file"""
        try:
            with open(self.config_file, 'w') as f:
                json.dump(self.config, f, indent=2)
        except Exception as e:
            print(f"Error saving config: {e}")
    
    def get(self, key: str, default: Any = None) -> Any:
        """Get configuration value"""
        return self.config.get(key, default)
    
    def set(self, key: str, value: Any):
        """Set configuration value"""
        self.config[key] = value
        self.save()
    
    @staticmethod
    def get_default_config() -> Dict[str, Any]:
        """Get default configuration"""
        return {
            "device_type": "pcan",
            "channel": "USB1",
            "baudrate": "BAUD_500K",
            "auto_connect": False,
            "dbc_file": None
        }


class MessageBuffer:
    """Circular buffer for storing recent CAN messages"""
    
    def __init__(self, max_size: int = 1000):
        self.max_size = max_size
        self.messages: list[Dict[str, Any]] = []
    
    def add(self, message: Dict[str, Any]):
        """Add message to buffer"""
        self.messages.append(message)
        
        # Keep only the most recent messages
        if len(self.messages) > self.max_size:
            self.messages = self.messages[-self.max_size:]
    
    def get_all(self) -> list[Dict[str, Any]]:
        """Get all messages in buffer"""
        return self.messages.copy()
    
    def get_recent(self, count: int = 100) -> list[Dict[str, Any]]:
        """Get most recent messages"""
        return self.messages[-count:]
    
    def clear(self):
        """Clear all messages"""
        self.messages.clear()
    
    def get_by_id(self, can_id: int) -> list[Dict[str, Any]]:
        """Get all messages with specific CAN ID"""
        return [msg for msg in self.messages if msg.get('id') == can_id]
    
    def get_unique_ids(self) -> set[int]:
        """Get set of unique CAN IDs in buffer"""
        return set(msg.get('id') for msg in self.messages if 'id' in msg)
