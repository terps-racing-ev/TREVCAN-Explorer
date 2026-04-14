#!/usr/bin/env python3
"""
Firmware Flasher Driver
======================
Object-oriented driver for flashing STM32L432 BMS modules via CAN bootloader.
Integrates with PCAN and CANable drivers.

Author: GitHub Copilot
Date: October 28, 2025
"""

import time
from typing import Optional, Callable
from dataclasses import dataclass
from pathlib import Path


# ============================================================================
# Bootloader Protocol Constants
# ============================================================================

# CAN IDs - 29-bit Extended IDs
CAN_HOST_ID = 0x18000701         # PC sends commands to this ID
CAN_BOOTLOADER_ID = 0x18000700   # Bootloader responds from this ID

# Commands
CMD_ERASE_FLASH = 0x01
CMD_WRITE_DATA = 0x07
CMD_READ_FLASH = 0x03
CMD_JUMP_TO_APP = 0x04
CMD_GET_STATUS = 0x05
CMD_SET_ADDRESS = 0x06

# Responses
RESP_ACK = 0x10
RESP_NACK = 0x11
RESP_READY = 0x14
RESP_DATA = 0x15

# Error Codes
ERROR_DESCRIPTIONS = {
    0x00: "No error",
    0x01: "Invalid command",
    0x02: "Invalid address",
    0x03: "Flash erase failed",
    0x04: "Flash write failed",
    0x05: "Invalid data length",
    0x06: "No valid application",
    0x07: "Operation timeout"
}

# Memory Configuration
APP_START_ADDRESS = 0x08008000
APP_MAX_SIZE = 208 * 1024  # 208 KB

# Timing
RESPONSE_TIMEOUT = 1.0
ERASE_TIMEOUT = 15.0
WRITE_CHUNK_SIZE = 4  # 4 bytes per CAN message


# ============================================================================
# Data Classes
# ============================================================================

@dataclass
class FlashProgress:
    """Progress information for firmware flashing"""
    stage: str  # 'reset', 'erase', 'write', 'verify', 'jump', 'complete', 'error'
    progress: int  # Percentage 0-100
    message: str
    bytes_processed: int = 0
    total_bytes: int = 0


@dataclass
class BootloaderStatus:
    """Bootloader status information"""
    state: int
    error: int
    bytes_written: int


# ============================================================================
# Firmware Flasher Driver
# ============================================================================

class FirmwareFlasher:
    """
    Driver for flashing firmware to STM32L432 BMS modules via CAN bootloader.
    Works with both PCAN and CANable adapters.
    """

    def __init__(self, can_driver, progress_callback: Optional[Callable[[FlashProgress], None]] = None):
        """
        Initialize firmware flasher.

        Args:
            can_driver: Instance of PCANDriver or CANableDriver
            progress_callback: Optional callback function to report progress
        """
        self.driver = can_driver
        self.progress_callback = progress_callback

    def _report_progress(self, stage: str, progress: int, message: str, 
                        bytes_processed: int = 0, total_bytes: int = 0):
        """Report progress to callback if provided"""
        if self.progress_callback:
            self.progress_callback(FlashProgress(
                stage=stage,
                progress=progress,
                message=message,
                bytes_processed=bytes_processed,
                total_bytes=total_bytes
            ))

    def _send_command(self, command: int, data: list) -> bool:
        """Send a command to the bootloader"""
        msg_data = [command] + data
        while len(msg_data) < 8:
            msg_data.append(0x00)
        
        # Debug log for all commands
        cmd_names = {
            CMD_ERASE_FLASH: "ERASE_FLASH",
            CMD_SET_ADDRESS: "SET_ADDRESS",
            CMD_WRITE_DATA: "WRITE_DATA",
            CMD_READ_FLASH: "READ_FLASH",
            CMD_JUMP_TO_APP: "JUMP_TO_APP",
            CMD_GET_STATUS: "GET_STATUS"
        }
        cmd_name = cmd_names.get(command, f"CMD_{command:02X}")
        data_hex = ' '.join([f'{b:02X}' for b in msg_data[:8]])
        print(f"[DEBUG] TX {cmd_name}: ID=0x{CAN_HOST_ID:08X}, Data=[{data_hex}]")
        
        result = self.driver.send_message(CAN_HOST_ID, bytes(msg_data[:8]), is_extended=True)
        print(f"[DEBUG] send_message returned: {result}")
        return result

    def _wait_response(self, timeout: float = RESPONSE_TIMEOUT):
        """
        Wait for a response from bootloader.
        Skips READY/heartbeat messages (0x14 0x01 0x00...) during normal operations.
        """
        print(f"[DEBUG] _wait_response: waiting up to {timeout}s for response...")
        start_time = time.time()
        msg_count = 0
        heartbeat_count = 0
        
        while (time.time() - start_time) < timeout:
            msg = self.driver.read_message(timeout=0.1)
            if msg and msg.id == CAN_BOOTLOADER_ID:
                msg_count += 1
                # Log every message we see for debugging
                try:
                    data_hex = ' '.join([f"{b:02X}" for b in msg.data])
                except Exception:
                    data_hex = str(msg.data)
                
                elapsed = time.time() - start_time
                print(f"[DEBUG] _wait_response saw (t={elapsed:.2f}s, msg#{msg_count}): ID=0x{msg.id:X}, Data=[{data_hex}]")

                # Skip the canonical heartbeat message (READY 0x14 0x01 0x00)
                if (msg.data and msg.data[0] == RESP_READY and 
                    len(msg.data) >= 3 and 
                    msg.data[1] == 0x01 and 
                    msg.data[2] == 0x00):
                    heartbeat_count += 1
                    print(f"[DEBUG] _wait_response skipping canonical heartbeat (14 01 00) - heartbeat #{heartbeat_count}")
                    continue

                # Return any other message (ACK, NACK, DATA, or READY with special codes)
                print(f"[DEBUG] _wait_response returning message with response code: 0x{msg.data[0]:02X}")
                return msg
        
        print(f"[DEBUG] _wait_response timeout after {timeout}s - saw {msg_count} messages ({heartbeat_count} heartbeats)")
        return None

    def send_reset_message(self, module_number: int) -> bool:
        """
        Send reset message to specific BMS module.

        Args:
            module_number: Module number (0-5)

        Returns:
            True if reset successful and READY message received
        """
        if module_number < 0 or module_number > 5:
            self._report_progress('error', 0, f'Invalid module number: {module_number}')
            return False

        self._report_progress('reset', 0, f'Resetting Module {module_number}...')

        # Calculate reset CAN ID: 0x08F00F02 + (module_number << 16)
        reset_id = 0x08F00F02 + (module_number << 16)

        # Send reset message
        if not self.driver.send_message(reset_id, bytes([0] * 8), is_extended=True):
            self._report_progress('error', 0, 'Failed to send reset message')
            return False

        # Wait for bootloader READY message
        start_time = time.time()
        while (time.time() - start_time) < 3.0:
            msg = self.driver.read_message(timeout=0.1)
            if msg and msg.id == CAN_BOOTLOADER_ID:
                if len(msg.data) > 0 and msg.data[0] == RESP_READY:
                    version = msg.data[1] if len(msg.data) > 1 else 0
                    self._report_progress('reset', 100, f'Bootloader ready (v{version})')
                    return True

        self._report_progress('error', 0, 'No READY message from bootloader')
        return False

    def erase_flash(self) -> bool:
        """Erase application flash area"""
        self._report_progress('erase', 0, 'Erasing flash memory...')

        print(f"[DEBUG] Sending ERASE_FLASH command...")
        if not self._send_command(CMD_ERASE_FLASH, []):
            self._report_progress('error', 0, 'Failed to send erase command')
            return False

        print(f"[DEBUG] Waiting for erase response (timeout={ERASE_TIMEOUT}s)...")
        start_time = time.time()
        resp = self._wait_response(timeout=ERASE_TIMEOUT)
        elapsed = time.time() - start_time
        print(f"[DEBUG] Erase wait completed after {elapsed:.2f}s")

        if not resp:
            print(f"[DEBUG] Erase: No response received after {elapsed:.2f}s")
            self._report_progress('error', 0, 'Erase timeout')
            return False

        # Log the actual response for debugging
        resp_data_hex = ' '.join([f'{b:02X}' for b in resp.data])
        print(f"[DEBUG] Erase response: ID=0x{resp.id:X}, Data=[{resp_data_hex}]")

        if resp.data[0] == RESP_ACK:
            print(f"[DEBUG] Erase ACK received!")
            self._report_progress('erase', 100, 'Flash erased successfully')
            return True
        elif resp.data[0] == RESP_NACK:
            error_code = resp.data[1] if len(resp.data) > 1 else 0
            error_desc = ERROR_DESCRIPTIONS.get(error_code, f'Error {error_code}')
            print(f"[DEBUG] Erase NACK: {error_desc}")
            self._report_progress('error', 0, f'Erase failed: {error_desc}')
            return False

        print(f"[DEBUG] Unexpected erase response: 0x{resp.data[0]:02X}")
        self._report_progress('error', 0, 
                            f'Unexpected erase response: 0x{resp.data[0]:02X}')
        return False

    def set_address(self, address: int) -> bool:
        """Set write address pointer"""
        # Clear any pending messages in the queue before sending SET_ADDRESS
        print(f"[DEBUG] set_address: Clearing receive queue before sending command...")
        cleared = 0
        while True:
            msg = self.driver.read_message(timeout=0.01)
            if msg:
                cleared += 1
                data_hex = ' '.join([f'{b:02X}' for b in msg.data])
                print(f"[DEBUG] set_address: Cleared msg #{cleared}: ID=0x{msg.id:X}, Data=[{data_hex}]")
            else:
                break
        print(f"[DEBUG] set_address: Cleared {cleared} message(s) from queue")
        
        addr_bytes = [
            (address >> 24) & 0xFF,
            (address >> 16) & 0xFF,
            (address >> 8) & 0xFF,
            address & 0xFF
        ]

        print(f"[DEBUG] set_address: Sending SET_ADDRESS for address 0x{address:08X}")
        if not self._send_command(CMD_SET_ADDRESS, addr_bytes):
            return False

        # The bootloader may send heartbeat messages between processing commands
        # We need to wait through heartbeats to get the actual ACK response
        # Try for up to 15 seconds, skipping heartbeats
        print(f"[DEBUG] set_address: Waiting for ACK response...")
        start_time = time.time()
        max_wait = 15.0
        
        while (time.time() - start_time) < max_wait:
            msg = self.driver.read_message(timeout=0.1)
            
            if msg and msg.id == CAN_BOOTLOADER_ID:
                # Log every message
                try:
                    data_hex = ' '.join([f"{b:02X}" for b in msg.data])
                except Exception:
                    data_hex = str(msg.data)
                print(f"[DEBUG] set_address read: ID=0x{msg.id:X}, Data=[{data_hex}]")
                
                # Skip heartbeat messages and keep waiting for ACK
                if (msg.data and msg.data[0] == RESP_READY and 
                    len(msg.data) >= 3 and 
                    msg.data[1] == 0x01 and 
                    msg.data[2] == 0x00):
                    print("[DEBUG] set_address: skipping heartbeat, continuing to wait for ACK...")
                    continue
                
                # Got a non-heartbeat message - should be ACK or NACK
                print(f"[DEBUG] set_address received response: 0x{msg.data[0]:02X}")
                return msg.data[0] == RESP_ACK
        
        print(f"[DEBUG] Set address timeout after {max_wait}s - no ACK received")
        return False

    def write_4bytes(self, data: bytes, wait_ack: bool = True) -> bool:
        """Write exactly 4 bytes to flash"""
        if len(data) != 4:
            return False

        cmd_data = [0x04] + list(data)
        if not self._send_command(CMD_WRITE_DATA, cmd_data):
            return False

        if not wait_ack:
            return True

        resp = self._wait_response(timeout=0.1)
        if not resp:
            return False

        if resp.data[0] == RESP_ACK:
            return True
        elif resp.data[0] == RESP_NACK:
            error_code = resp.data[1] if len(resp.data) > 1 else 0
            self._report_progress('error', 0, 
                                f'Write failed: {ERROR_DESCRIPTIONS.get(error_code, "Unknown")}')
            return False

        return False

    def read_pending_acks(self, expected_count: int, timeout: float = 0.5) -> int:
        """Read multiple pending ACK responses"""
        ack_count = 0
        start_time = time.time()

        while ack_count < expected_count and (time.time() - start_time) < timeout:
            remaining_time = timeout - (time.time() - start_time)
            resp = self._wait_response(timeout=min(0.05, remaining_time))

            if not resp:
                break

            if resp.data[0] == RESP_ACK:
                ack_count += 1
            elif resp.data[0] == RESP_NACK:
                error_code = resp.data[1] if len(resp.data) > 1 else 0
                self._report_progress('error', 0, 
                                    f'Write failed: {ERROR_DESCRIPTIONS.get(error_code, "Unknown")}')
                return -1

        return ack_count

    def write_firmware(self, firmware_data: bytes, batch_size: int = 16) -> bool:
        """Write complete firmware to flash"""
        total_bytes = len(firmware_data)
        chunk_size = WRITE_CHUNK_SIZE

        self._report_progress('write', 0, 'Writing firmware...', 0, total_bytes)

        # Clear any pending heartbeat messages before sending SET_ADDRESS
        # (bootloader may have sent heartbeats after erase completed)
        cleared = 0
        while True:
            msg = self.driver.read_message(timeout=0.05)
            if msg:
                cleared += 1
            else:
                break
        if cleared > 0:
            print(f"[DEBUG] Cleared {cleared} pending message(s) before SET_ADDRESS")

        # Set initial address
        if not self.set_address(APP_START_ADDRESS):
            self._report_progress('error', 0, 'Failed to set initial address')
            return False

        bytes_written = 0
        chunks_in_batch = 0
        start_time = time.time()

        while bytes_written < total_bytes:
            # Get next 4-byte chunk
            chunk_end = min(bytes_written + chunk_size, total_bytes)
            chunk = firmware_data[bytes_written:chunk_end]

            # Pad if needed
            if len(chunk) < 4:
                chunk = chunk + b'\xFF' * (4 - len(chunk))

            # Send without waiting for ACK
            is_last_chunk = (bytes_written + chunk_size >= total_bytes)
            wait_for_ack = (chunks_in_batch >= batch_size - 1) or is_last_chunk

            if not self.write_4bytes(chunk, wait_ack=False):
                self._report_progress('error', 0, f'Write failed at offset 0x{bytes_written:08X}')
                return False

            bytes_written += len(chunk) if chunk_end != total_bytes or len(chunk) == 4 else (chunk_end - bytes_written)
            chunks_in_batch += 1

            # Check batched ACKs
            if wait_for_ack:
                ack_count = self.read_pending_acks(chunks_in_batch, timeout=1.0)
                if ack_count < 0 or ack_count != chunks_in_batch:
                    self._report_progress('error', 0, 
                                        f'ACK mismatch at offset 0x{bytes_written - chunks_in_batch * chunk_size:08X}')
                    return False
                chunks_in_batch = 0

            # Update progress
            progress = int((bytes_written * 100) / total_bytes)
            elapsed = time.time() - start_time
            speed = bytes_written / elapsed / 1024 if elapsed > 0 else 0
            self._report_progress('write', progress, 
                                f'Writing: {speed:.1f} KB/s', 
                                bytes_written, total_bytes)

        elapsed = time.time() - start_time
        avg_speed = total_bytes / elapsed / 1024 if elapsed > 0 else 0
        self._report_progress('write', 100, 
                            f'Write complete ({avg_speed:.1f} KB/s)', 
                            total_bytes, total_bytes)
        return True

    def verify_flash(self, expected_data: bytes, batch_size: int = 8) -> bool:
        """Verify flashed data by reading back"""
        self._report_progress('verify', 0, 'Verifying flash...', 0, len(expected_data))

        address = APP_START_ADDRESS
        bytes_verified = 0
        chunk_size = 7  # Max per CAN message
        start_time = time.time()

        while bytes_verified < len(expected_data):
            batch_reads = []
            current_address = address

            # Build batch of read requests
            for _ in range(batch_size):
                if bytes_verified >= len(expected_data):
                    break

                remaining = len(expected_data) - bytes_verified
                read_size = min(chunk_size, remaining)

                batch_reads.append({
                    'address': current_address,
                    'size': read_size,
                    'offset': bytes_verified
                })

                bytes_verified += read_size
                current_address += read_size

            # Send all read commands
            for read_info in batch_reads:
                addr_bytes = [
                    (read_info['address'] >> 24) & 0xFF,
                    (read_info['address'] >> 16) & 0xFF,
                    (read_info['address'] >> 8) & 0xFF,
                    read_info['address'] & 0xFF,
                    read_info['size']
                ]
                if not self._send_command(CMD_READ_FLASH, addr_bytes):
                    self._report_progress('error', 0, 
                                        f'Failed to send read at 0x{read_info["address"]:08X}')
                    return False

            # Read responses and verify
            for read_info in batch_reads:
                msg = self._wait_response(timeout=0.2)

                if not msg or len(msg.data) == 0 or msg.data[0] != RESP_DATA:
                    self._report_progress('error', 0, 
                                        f'Failed to read at 0x{read_info["address"]:08X}')
                    return False

                read_data = bytes(msg.data[1:1+read_info['size']])
                expected_chunk = expected_data[read_info['offset']:read_info['offset'] + read_info['size']]

                if read_data != expected_chunk:
                    self._report_progress('error', 0, 
                                        f'Verification failed at 0x{read_info["address"]:08X}')
                    return False

            address = current_address

            # Update progress
            progress = int((bytes_verified * 100) / len(expected_data))
            elapsed = time.time() - start_time
            speed = bytes_verified / elapsed / 1024 if elapsed > 0 else 0
            self._report_progress('verify', progress, 
                                f'Verifying: {speed:.1f} KB/s', 
                                bytes_verified, len(expected_data))

        self._report_progress('verify', 100, 'Verification successful', 
                            len(expected_data), len(expected_data))
        return True

    def jump_to_application(self) -> bool:
        """Command bootloader to jump to application"""
        self._report_progress('jump', 0, 'Starting application...')

        if not self._send_command(CMD_JUMP_TO_APP, []):
            self._report_progress('error', 0, 'Failed to send jump command')
            return False

        resp = self._wait_response(timeout=0.5)

        if resp and resp.data[0] == RESP_ACK:
            self._report_progress('jump', 100, 'Application started')
            return True
        elif resp and resp.data[0] == RESP_NACK:
            error_code = resp.data[1] if len(resp.data) > 1 else 0
            self._report_progress('error', 0, 
                                f'Jump failed: {ERROR_DESCRIPTIONS.get(error_code, "Unknown")}')
            return False
        else:
            # No response might mean bootloader jumped
            self._report_progress('jump', 100, 'Jump command sent')
            return True

    @staticmethod
    def pad_to_4byte_boundary(data: bytes) -> bytes:
        """Pad data to 4-byte boundary"""
        padding_needed = (4 - len(data) % 4) % 4
        if padding_needed > 0:
            data = data + b'\xFF' * padding_needed
        return data

    def flash_firmware(self, firmware_path: Path, module_number: int, 
                      verify: bool = True, jump: bool = True, 
                      batch_size: int = 16) -> bool:
        """
        Complete firmware flashing process.

        Args:
            firmware_path: Path to .bin file
            module_number: Module number to flash (0-5)
            verify: Verify by reading back (default: True)
            jump: Jump to application after flashing (default: True)
            batch_size: Number of chunks to batch (default: 16)

        Returns:
            True if flashing successful
        """
        try:
            # Read firmware file
            self._report_progress('write', 0, f'Loading {firmware_path.name}...')
            firmware_data = firmware_path.read_bytes()
            original_size = len(firmware_data)

            # Truncate if needed
            if original_size > APP_MAX_SIZE:
                self._report_progress('write', 0, 
                                    f'Truncating to {APP_MAX_SIZE} bytes')
                firmware_data = firmware_data[:APP_MAX_SIZE]
                original_size = len(firmware_data)

            # Pad to 4-byte boundary
            firmware_data = self.pad_to_4byte_boundary(firmware_data)

            # Reset module
            if not self.send_reset_message(module_number):
                return False

            time.sleep(0.5)  # Brief delay after reset

            # Erase flash
            if not self.erase_flash():
                return False

            # Write firmware
            if not self.write_firmware(firmware_data, batch_size=batch_size):
                return False

            # Verify
            if verify:
                if not self.verify_flash(firmware_data, batch_size=batch_size):
                    return False

            # Jump to application
            if jump:
                if not self.jump_to_application():
                    self._report_progress('error', 0, 'Jump command may have failed')

            self._report_progress('complete', 100, 'Flashing completed successfully!')
            return True

        except Exception as e:
            self._report_progress('error', 0, f'Error: {str(e)}')
            return False
