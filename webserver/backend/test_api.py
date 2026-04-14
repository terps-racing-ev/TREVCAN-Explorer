"""
Backend API Test Script
========================
Test the CAN backend API endpoints

Usage:
    python test_api.py
"""

import requests
import json
import time
from typing import Dict, Any

# API base URL
BASE_URL = "http://localhost:8000"


def print_section(title: str):
    """Print section header"""
    print("\n" + "=" * 60)
    print(f"  {title}")
    print("=" * 60)


def print_response(response: requests.Response):
    """Print formatted response"""
    print(f"Status: {response.status_code}")
    try:
        data = response.json()
        print(f"Response: {json.dumps(data, indent=2)}")
    except:
        print(f"Response: {response.text}")


def test_root():
    """Test root endpoint"""
    print_section("Test: Root Endpoint")
    response = requests.get(f"{BASE_URL}/")
    print_response(response)
    return response.status_code == 200


def test_get_devices():
    """Test device enumeration"""
    print_section("Test: Get Available Devices")
    response = requests.get(f"{BASE_URL}/devices")
    print_response(response)
    
    if response.status_code == 200:
        data = response.json()
        print(f"\nFound {len(data['devices'])} device(s)")
        return data
    return None


def test_connect(device_type: str = "pcan", channel: str = "USB1", baudrate: str = "BAUD_500K"):
    """Test device connection"""
    print_section(f"Test: Connect to {device_type.upper()} {channel}")
    
    payload = {
        "device_type": device_type,
        "channel": channel,
        "baudrate": baudrate
    }
    
    response = requests.post(f"{BASE_URL}/connect", json=payload)
    print_response(response)
    return response.status_code == 200


def test_status():
    """Test status endpoint"""
    print_section("Test: Get Bus Status")
    response = requests.get(f"{BASE_URL}/status")
    print_response(response)
    return response.status_code == 200


def test_send_message(can_id: int = 0x123, data: list = None):
    """Test sending a message"""
    print_section(f"Test: Send CAN Message (ID: 0x{can_id:X})")
    
    if data is None:
        data = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]
    
    payload = {
        "can_id": can_id,
        "data": data,
        "is_extended": False,
        "is_remote": False
    }
    
    response = requests.post(f"{BASE_URL}/send", json=payload)
    print_response(response)
    return response.status_code == 200


def test_stats():
    """Test statistics endpoint"""
    print_section("Test: Get Statistics")
    response = requests.get(f"{BASE_URL}/stats")
    print_response(response)
    return response.status_code == 200


def test_load_dbc(file_path: str):
    """Test DBC file loading"""
    print_section(f"Test: Load DBC File")
    
    payload = {
        "file_path": file_path
    }
    
    response = requests.post(f"{BASE_URL}/dbc/load", json=payload)
    print_response(response)
    return response.status_code == 200


def test_get_dbc_messages():
    """Test getting DBC messages"""
    print_section("Test: Get DBC Messages")
    response = requests.get(f"{BASE_URL}/dbc/messages")
    print_response(response)
    
    if response.status_code == 200:
        data = response.json()
        if data['success']:
            print(f"\nFound {len(data['messages'])} message(s) in DBC")
    
    return response.status_code == 200


def test_disconnect():
    """Test disconnection"""
    print_section("Test: Disconnect")
    response = requests.post(f"{BASE_URL}/disconnect")
    print_response(response)
    return response.status_code == 200


def run_full_test_suite():
    """Run complete test suite"""
    print("\n" + "=" * 60)
    print("  CAN Backend API Test Suite")
    print("=" * 60)
    print("\nMake sure the backend server is running!")
    print("Start it with: python api.py")
    print("\nPress Enter to continue or Ctrl+C to cancel...")
    try:
        input()
    except KeyboardInterrupt:
        print("\nTest cancelled")
        return
    
    results = {}
    
    # Test 1: Root endpoint
    results['root'] = test_root()
    time.sleep(0.5)
    
    # Test 2: Get devices
    devices_data = test_get_devices()
    results['get_devices'] = devices_data is not None
    time.sleep(0.5)
    
    # Determine which device to connect to
    device_type = "pcan"
    channel = "USB1"
    
    if devices_data and devices_data['devices']:
        # Use first available device
        first_device = devices_data['devices'][0]
        device_type = first_device['device_type']
        channel = first_device['name']
        print(f"\nUsing device: {device_type} - {channel}")
    
    # Test 3: Connect
    results['connect'] = test_connect(device_type, channel)
    time.sleep(0.5)
    
    if results['connect']:
        # Test 4: Status
        results['status'] = test_status()
        time.sleep(0.5)
        
        # Test 5: Send message
        results['send'] = test_send_message()
        time.sleep(0.5)
        
        # Test 6: Statistics
        results['stats'] = test_stats()
        time.sleep(0.5)
        
        # Test 7: Send multiple messages
        print_section("Test: Send Multiple Messages")
        for i in range(5):
            test_send_message(0x100 + i, [i, i+1, i+2, i+3, i+4, i+5, i+6, i+7])
            time.sleep(0.2)
        
        # Test 8: DBC file (if available)
        dbc_file = input("\nEnter DBC file path (or press Enter to skip): ").strip()
        if dbc_file:
            results['load_dbc'] = test_load_dbc(dbc_file)
            time.sleep(0.5)
            
            if results.get('load_dbc'):
                results['get_dbc_messages'] = test_get_dbc_messages()
                time.sleep(0.5)
        
        # Test 9: Disconnect
        results['disconnect'] = test_disconnect()
    else:
        print("\n⚠ Skipping connection-dependent tests (connection failed)")
    
    # Print summary
    print_section("Test Summary")
    passed = sum(1 for v in results.values() if v)
    total = len(results)
    
    print(f"\nTests Passed: {passed}/{total}")
    print("\nDetailed Results:")
    for test_name, result in results.items():
        status = "✓ PASS" if result else "✗ FAIL"
        print(f"  {status}: {test_name}")
    
    if passed == total:
        print("\n🎉 All tests passed!")
    else:
        print(f"\n⚠ {total - passed} test(s) failed")


def interactive_test():
    """Interactive test mode"""
    print("\n" + "=" * 60)
    print("  CAN Backend API Interactive Test")
    print("=" * 60)
    
    while True:
        print("\nAvailable commands:")
        print("  1. Get devices")
        print("  2. Connect")
        print("  3. Get status")
        print("  4. Send message")
        print("  5. Get stats")
        print("  6. Load DBC")
        print("  7. Get DBC messages")
        print("  8. Disconnect")
        print("  9. Run full test suite")
        print("  0. Exit")
        
        choice = input("\nEnter choice: ").strip()
        
        if choice == '1':
            test_get_devices()
        elif choice == '2':
            device_type = input("Device type (pcan/canable): ").strip()
            channel = input("Channel (e.g., USB1 or 0): ").strip()
            baudrate = input("Baudrate (default: BAUD_500K): ").strip() or "BAUD_500K"
            test_connect(device_type, channel, baudrate)
        elif choice == '3':
            test_status()
        elif choice == '4':
            can_id = int(input("CAN ID (hex, e.g., 123): "), 16)
            data_str = input("Data bytes (hex, space separated): ").strip()
            data = [int(b, 16) for b in data_str.split()] if data_str else None
            test_send_message(can_id, data)
        elif choice == '5':
            test_stats()
        elif choice == '6':
            file_path = input("DBC file path: ").strip()
            test_load_dbc(file_path)
        elif choice == '7':
            test_get_dbc_messages()
        elif choice == '8':
            test_disconnect()
        elif choice == '9':
            run_full_test_suite()
        elif choice == '0':
            print("Exiting...")
            break
        else:
            print("Invalid choice")


if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1 and sys.argv[1] == "--interactive":
        interactive_test()
    else:
        run_full_test_suite()
