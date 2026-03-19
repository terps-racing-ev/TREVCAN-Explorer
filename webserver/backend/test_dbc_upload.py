"""
Test DBC Upload Feature
========================
Quick test to verify DBC file upload functionality.
"""

import requests
import os
from pathlib import Path

API_URL = "http://localhost:8000"

def test_dbc_upload():
    """Test uploading a DBC file into the multi-DBC manager."""
    print("=" * 60)
    print("Testing DBC Upload Feature")
    print("=" * 60)
    
    # Path to test DBC file
    dbc_file = Path(__file__).parent.parent.parent / "bootloader" / "STM32L432_Bootloader.dbc"
    
    if not dbc_file.exists():
        print(f"✗ Test DBC file not found: {dbc_file}")
        return False
    
    print(f"✓ Found test DBC file: {dbc_file.name}")
    
    # Upload the DBC file
    print("\n1. Uploading DBC file...")
    try:
        with open(dbc_file, 'rb') as f:
            files = {'file': (dbc_file.name, f, 'application/octet-stream')}
            response = requests.post(f"{API_URL}/dbc/upload", files=files)
        
        if response.status_code == 200:
            data = response.json()
            print(f"   ✓ Upload successful!")
            print(f"   - Message: {data.get('message')}")
            print(f"   - File path: {data.get('file_path')}")
            print(f"   - Messages in DBC: {data.get('message_count')}")
        else:
            print(f"   ✗ Upload failed: {response.status_code}")
            print(f"   - Error: {response.text}")
            return False
    except Exception as e:
        print(f"   ✗ Upload error: {e}")
        return False
    
    # Check DBC manager state
    print("\n2. Checking DBC manager state...")
    try:
        response = requests.get(f"{API_URL}/dbc/current")
        if response.status_code == 200:
            data = response.json()
            print(f"   ✓ Status retrieved")
            print(f"   - Loaded: {data.get('loaded')}")
            print(f"   - Effective filename: {data.get('filename')}")
            print(f"   - Active count: {data.get('active_count')}")
            files = data.get('files', [])
            uploaded_entry = next((item for item in files if item.get('filename') == dbc_file.name), None)
            if not uploaded_entry:
                print(f"   ✗ Uploaded file is missing from manager list")
                return False

            print(f"   - Uploaded entry enabled: {uploaded_entry.get('enabled')}")
            print(f"   - Uploaded entry priority: {uploaded_entry.get('priority')}")
            if uploaded_entry.get('enabled'):
                print(f"   ✗ Newly uploaded DBC should remain disabled until enabled manually")
                return False
        else:
            print(f"   ✗ Status check failed: {response.status_code}")
            return False
    except Exception as e:
        print(f"   ✗ Status error: {e}")
        return False

    # Enable the uploaded file through config update
    print("\n3. Enabling uploaded DBC and promoting it to top priority...")
    try:
        response = requests.get(f"{API_URL}/dbc/config")
        if response.status_code != 200:
            print(f"   ✗ Failed to load DBC config: {response.status_code}")
            return False

        config = response.json()
        files = config.get('files', [])
        files.sort(key=lambda item: item.get('priority', 0))

        target_index = next((index for index, item in enumerate(files) if item.get('filename') == dbc_file.name), None)
        if target_index is None:
            print(f"   ✗ Uploaded file missing from config response")
            return False

        enabled_item = files.pop(target_index)
        enabled_item['enabled'] = True
        files.insert(0, enabled_item)

        response = requests.post(
            f"{API_URL}/dbc/config",
            json={
                'files': [
                    {
                        'filename': item['filename'],
                        'enabled': item['enabled']
                    }
                    for item in files
                ]
            }
        )
        if response.status_code != 200:
            print(f"   ✗ Failed to update DBC config: {response.status_code}")
            print(f"   - Error: {response.text}")
            return False

        data = response.json()
        print(f"   ✓ DBC config updated")
        print(f"   - Effective filename: {data.get('filename')}")
        print(f"   - Active count: {data.get('active_count')}")
        if data.get('filename') != dbc_file.name:
            print(f"   ✗ Expected {dbc_file.name} to become effective after enabling it")
            return False
    except Exception as e:
        print(f"   ✗ Config update error: {e}")
        return False

    # List all DBC files
    print("\n4. Listing uploaded DBC files...")
    try:
        response = requests.get(f"{API_URL}/dbc/list")
        if response.status_code == 200:
            data = response.json()
            files = data.get('files', [])
            print(f"   ✓ Found {len(files)} file(s):")
            for file_info in files:
                size_kb = file_info.get('size', 0) / 1024
                enabled = 'enabled' if file_info.get('enabled') else 'disabled'
                print(f"   - {file_info['filename']} ({size_kb:.1f} KB, {enabled}, priority={file_info.get('priority')})")
        else:
            print(f"   ✗ List failed: {response.status_code}")
            return False
    except Exception as e:
        print(f"   ✗ List error: {e}")
        return False
    
    print("\n" + "=" * 60)
    print("✓ All DBC upload tests passed!")
    print("=" * 60)
    print("\nNOTE: Uploaded DBC files now persist in the manager and must be enabled explicitly.")
    print(f"Stored in: webserver/backend/dbc_files/")
    return True

if __name__ == "__main__":
    try:
        success = test_dbc_upload()
        exit(0 if success else 1)
    except Exception as e:
        print(f"\n✗ Test failed with exception: {e}")
        import traceback
        traceback.print_exc()
        exit(1)
