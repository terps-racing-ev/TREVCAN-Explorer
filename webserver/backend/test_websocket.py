"""
WebSocket Test Client
======================
Test the WebSocket endpoint for real-time CAN message streaming

Usage:
    python test_websocket.py
"""

import asyncio
import websockets
import json
from datetime import datetime
import sys


async def listen_can_messages(url: str = "ws://localhost:8000/ws/can"):
    """Connect to WebSocket and listen for CAN messages"""
    print("=" * 60)
    print("  CAN WebSocket Test Client")
    print("=" * 60)
    print(f"\nConnecting to: {url}")
    print("Press Ctrl+C to stop\n")
    
    message_count = 0
    start_time = datetime.now()
    
    try:
        async with websockets.connect(url) as websocket:
            print("✓ Connected to WebSocket")
            print("Waiting for CAN messages...\n")
            
            while True:
                try:
                    # Receive message
                    message = await websocket.recv()
                    message_count += 1
                    
                    # Parse JSON
                    data = json.loads(message)
                    
                    # Check if it's a heartbeat
                    if data.get('type') == 'heartbeat':
                        continue
                    
                    # Format and display CAN message
                    can_id = data.get('id', 0)
                    can_data = data.get('data', [])
                    timestamp = data.get('timestamp', 0)
                    is_extended = data.get('is_extended', False)
                    dlc = data.get('dlc', 0)
                    
                    # Format data bytes
                    data_str = ' '.join([f'{b:02X}' for b in can_data])
                    
                    # Format ID
                    id_type = "EXT" if is_extended else "STD"
                    id_str = f"0x{can_id:08X}" if is_extended else f"0x{can_id:03X}"
                    
                    # Calculate message rate
                    elapsed = (datetime.now() - start_time).total_seconds()
                    rate = message_count / elapsed if elapsed > 0 else 0
                    
                    # Print message
                    print(f"[{message_count:6d}] {id_str} [{id_type}] DLC:{dlc} [{data_str}] ({rate:.1f} msg/s)")
                    
                    # Print decoded signals if available
                    if 'decoded' in data:
                        decoded = data['decoded']
                        msg_name = decoded.get('message_name', 'Unknown')
                        signals = decoded.get('signals', {})
                        
                        print(f"           ↳ {msg_name}")
                        for signal_name, value in signals.items():
                            print(f"             • {signal_name}: {value}")
                    
                except json.JSONDecodeError as e:
                    print(f"Error decoding JSON: {e}")
                except Exception as e:
                    print(f"Error processing message: {e}")
                    
    except websockets.exceptions.ConnectionClosed:
        print("\n✗ WebSocket connection closed")
    except KeyboardInterrupt:
        print("\n\nStopped by user")
    except Exception as e:
        print(f"\n✗ Error: {e}")
    finally:
        elapsed = (datetime.now() - start_time).total_seconds()
        rate = message_count / elapsed if elapsed > 0 else 0
        
        print("\n" + "=" * 60)
        print("  Statistics")
        print("=" * 60)
        print(f"Total Messages: {message_count}")
        print(f"Duration: {elapsed:.1f} seconds")
        print(f"Average Rate: {rate:.2f} msg/s")
        print("=" * 60)


async def send_heartbeat(url: str = "ws://localhost:8000/ws/can", interval: int = 5):
    """Send periodic heartbeat to keep connection alive"""
    try:
        async with websockets.connect(url) as websocket:
            while True:
                await websocket.send("heartbeat")
                await asyncio.sleep(interval)
    except:
        pass


async def test_websocket():
    """Test WebSocket connection"""
    # You can run both listening and heartbeat sending concurrently
    await listen_can_messages()


if __name__ == "__main__":
    # Check if custom URL provided
    url = "ws://localhost:8000/ws/can"
    if len(sys.argv) > 1:
        url = sys.argv[1]
    
    # Run the async listener
    try:
        asyncio.run(listen_can_messages(url))
    except KeyboardInterrupt:
        print("\nExiting...")
