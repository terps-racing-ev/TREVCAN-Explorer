# CAN Communication Backend API

Python FastAPI backend for CAN device communication with real-time WebSocket support.

## Features

- **REST API** for CAN device control
- **WebSocket** streaming for real-time CAN messages
- **PCAN** and **CANable** device support
- **DBC file** parsing and message decoding
- **CORS** enabled for web frontend integration

## Installation

### 1. Install Python Dependencies

```bash
pip install -r ../../requirements.txt
```

### 2. Windows: Install libusb for CANable Support

Download `libusb-1.0.dll` and place it in the project root directory:
- Download from: https://libusb.info/
- Or use: https://github.com/libusb/libusb/releases

### 3. Linux: Setup USB Permissions for CANable

```bash
# Add user to plugdev group
sudo usermod -a -G plugdev $USER

# Create udev rule for CANable (optional)
sudo nano /etc/udev/rules.d/99-canable.rules
# Add: SUBSYSTEM=="usb", ATTR{idVendor}=="1d50", ATTR{idProduct}=="606f", MODE="0666"

# Reload udev rules
sudo udevadm control --reload-rules
sudo udevadm trigger
```

## Running the Backend

### Development Mode (with auto-reload)

```bash
cd webserver/backend
python api.py
```

Or using uvicorn directly:

```bash
uvicorn api:app --reload --host 0.0.0.0 --port 8000
```

### Production Mode

```bash
uvicorn api:app --host 0.0.0.0 --port 8000 --workers 4
```

The API will be available at:
- **API**: http://localhost:8000
- **Docs**: http://localhost:8000/docs
- **WebSocket**: ws://localhost:8000/ws/can

## API Endpoints

### Device Management

#### `GET /devices`
Get list of available CAN devices (PCAN and CANable).

**Response:**
```json
{
  "pcan_available": true,
  "canable_available": true,
  "devices": [
    {
      "device_type": "pcan",
      "index": 0,
      "name": "USB1",
      "description": "PCAN USB1",
      "available": true,
      "occupied": false
    }
  ]
}
```

#### `POST /connect`
Connect to a CAN device.

**Request:**
```json
{
  "device_type": "pcan",
  "channel": "USB1",
  "baudrate": "BAUD_500K"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Connected successfully",
  "device_type": "pcan",
  "channel": "USB1",
  "baudrate": "BAUD_500K"
}
```

#### `POST /disconnect`
Disconnect from current CAN device.

**Response:**
```json
{
  "success": true,
  "message": "Disconnected successfully"
}
```

#### `GET /status`
Get current bus status.

**Response:**
```json
{
  "connected": true,
  "device_type": "pcan",
  "channel": "USB1",
  "baudrate": "BAUD_500K",
  "status": "OK"
}
```

### Message Transmission

#### `POST /send`
Send a CAN message.

**Request:**
```json
{
  "can_id": 291,
  "data": [1, 2, 3, 4, 5, 6, 7, 8],
  "is_extended": false,
  "is_remote": false
}
```

**Response:**
```json
{
  "success": true,
  "message": "Message sent successfully"
}
```

### DBC File Support

#### `POST /dbc/load`
Load a DBC file for message decoding.

**Request:**
```json
{
  "file_path": "C:/path/to/file.dbc"
}
```

**Response:**
```json
{
  "success": true,
  "message": "DBC file loaded successfully",
  "file_path": "C:/path/to/file.dbc",
  "message_count": 42
}
```

#### `GET /dbc/messages`
Get list of messages from loaded DBC file.

**Response:**
```json
{
  "success": true,
  "messages": [
    {
      "name": "BatteryStatus",
      "frame_id": 256,
      "is_extended": false,
      "dlc": 8,
      "signals": [...]
    }
  ]
}
```

### Statistics

#### `GET /stats`
Get message statistics.

**Response:**
```json
{
  "connected": true,
  "message_count": 1542,
  "uptime_seconds": 125.4,
  "message_rate": 12.29
}
```

## WebSocket Interface

### `WS /ws/can`
Real-time CAN message streaming.

**Connection:**
```javascript
const ws = new WebSocket('ws://localhost:8000/ws/can');

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log('CAN Message:', message);
};
```

**Message Format:**
```json
{
  "id": 291,
  "data": [1, 2, 3, 4, 5, 6, 7, 8],
  "timestamp": 1234567890.123,
  "is_extended": false,
  "is_remote": false,
  "dlc": 8,
  "decoded": {
    "message_name": "BatteryStatus",
    "signals": {
      "Voltage": 48.5,
      "Current": 12.3
    }
  }
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    FastAPI Backend                       │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  REST API          WebSocket          DBC Parser         │
│  ────────          ─────────          ──────────         │
│  • /devices        • /ws/can          • cantools         │
│  • /connect        • Real-time        • Auto-decode      │
│  • /send           • Broadcast        • Signal extract   │
│  • /status                                               │
│                                                           │
├─────────────────────────────────────────────────────────┤
│                    CAN Drivers                           │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  PCAN Driver                CANable Driver               │
│  ────────────               ───────────────              │
│  • python-can               • python-can                 │
│  • PCAN API                 • gs_usb/libusb              │
│  • USB support              • candleLight firmware       │
│                                                           │
└─────────────────────────────────────────────────────────┘
           │                           │
           ▼                           ▼
    ┌──────────┐              ┌──────────────┐
    │   PCAN   │              │   CANable    │
    │   USB    │              │  (gs_usb)    │
    └──────────┘              └──────────────┘
```

## Development

### API Documentation

Once running, visit:
- **Swagger UI**: http://localhost:8000/docs
- **ReDoc**: http://localhost:8000/redoc

### Testing with curl

```bash
# Get devices
curl http://localhost:8000/devices

# Connect to PCAN
curl -X POST http://localhost:8000/connect \
  -H "Content-Type: application/json" \
  -d '{"device_type":"pcan","channel":"USB1","baudrate":"BAUD_500K"}'

# Send message
curl -X POST http://localhost:8000/send \
  -H "Content-Type: application/json" \
  -d '{"can_id":291,"data":[1,2,3,4,5,6,7,8],"is_extended":false}'

# Get status
curl http://localhost:8000/status

# Disconnect
curl -X POST http://localhost:8000/disconnect
```

### Testing WebSocket with Python

```python
import asyncio
import websockets
import json

async def listen_can_messages():
    uri = "ws://localhost:8000/ws/can"
    async with websockets.connect(uri) as websocket:
        while True:
            message = await websocket.recv()
            data = json.loads(message)
            print(f"Received: {data}")

asyncio.run(listen_can_messages())
```

## Error Handling

The API uses standard HTTP status codes:
- `200`: Success
- `400`: Bad request (e.g., already connected)
- `404`: Not found (e.g., DBC file)
- `500`: Internal server error (e.g., driver failure)

Error response format:
```json
{
  "detail": "Error message description"
}
```

## Next Steps

1. Build the web frontend (React, Vue, or vanilla JS)
2. Connect frontend to this backend via REST API and WebSocket
3. Deploy backend as a service
4. Add authentication if needed
5. Configure CORS for production domain

## License

See project root LICENSE file.
