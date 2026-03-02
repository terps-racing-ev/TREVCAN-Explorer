# PythonCAN-Utils Web Backend

**Modern web-based CAN communication tool with Python backend and future web frontend**

This project transforms the Python GUI application into a scalable web-based solution with:
- **Python FastAPI Backend** - RESTful API + WebSocket for real-time CAN communication
- **Web Frontend** (Coming Soon) - Modern browser-based UI
- **PCAN & CANable Support** - Works with both device types
- **DBC File Support** - Automatic message decoding

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Web Frontend (Future)                    │
│                   React / Vue / Vanilla JS                   │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  HTTP REST API              WebSocket Streaming              │
│  ──────────────             ──────────────────               │
│  • Device Control           • Real-time Messages             │
│  • Message Send             • Auto-broadcast                 │
│  • DBC Management           • Low latency                    │
│                                                               │
├─────────────────────────────────────────────────────────────┤
│                     Python Backend (Current)                 │
│                         FastAPI + uvicorn                    │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  PCAN Driver                 CANable Driver                  │
│  ────────────                ───────────────                 │
│  • python-can                • python-can                    │
│  • PCAN API                  • gs_usb / libusb               │
│                                                               │
└─────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
  ┌──────────┐                  ┌──────────────┐
  │   PCAN   │                  │   CANable    │
  │   USB    │                  │  (gs_usb)    │
  └──────────┘                  └──────────────┘
```

---

## 📋 Current Status

### ✅ Completed: Python Backend

The Python backend is **fully functional** and ready to use:

- ✅ FastAPI REST API with full CRUD operations
- ✅ WebSocket real-time message streaming
- ✅ PCAN device support
- ✅ CANable device support (gs_usb/candleLight)
- ✅ DBC file loading and automatic decoding
- ✅ Device enumeration and management
- ✅ Message statistics and monitoring
- ✅ CORS enabled for web frontend
- ✅ Auto-generated API documentation (Swagger/ReDoc)
- ✅ Comprehensive test suite

### 🚧 Coming Next: Web Frontend

The web frontend will be built separately and communicate with this backend via:
- REST API for control operations
- WebSocket for real-time CAN message streaming

---

## 🚀 Quick Start

### Prerequisites

- Python 3.8 or higher
- PCAN-USB adapter (optional, if using PCAN)
- CANable adapter with candleLight firmware (optional, if using CANable)
- Windows: `libusb-1.0.dll` for CANable support
- Linux: USB permissions for CANable

### Installation

1. **Clone the repository**
   ```bash
   cd webserver/backend
   ```

2. **Install dependencies**
   ```bash
   pip install -r ../requirements.txt
   ```

3. **Windows: Install libusb for CANable**
   - Download libusb from https://libusb.info/
   - Place `libusb-1.0.dll` in project root

4. **Linux: Setup USB permissions for CANable**
   ```bash
   sudo usermod -a -G plugdev $USER
   # Logout and login for changes to take effect
   ```

### Running the Backend

#### Option 1: Using startup scripts (recommended)

**Windows:**
```bash
start.bat
```

**Linux/Mac:**
```bash
chmod +x start.sh
./start.sh
```

#### Option 2: Direct execution

```bash
python api.py
```

#### Option 3: Using uvicorn

```bash
uvicorn api:app --reload --host 0.0.0.0 --port 8000
```

### Accessing the Backend

Once running:
- **API Root**: http://localhost:8000
- **Interactive Docs**: http://localhost:8000/docs (Swagger UI)
- **Alternative Docs**: http://localhost:8000/redoc
- **WebSocket**: ws://localhost:8000/ws/can

---

## 📚 API Documentation

### Key Endpoints

#### Device Management

- `GET /devices` - List available CAN devices
- `POST /connect` - Connect to a device
- `POST /disconnect` - Disconnect from device
- `GET /status` - Get connection status

#### Message Operations

- `POST /send` - Send a CAN message
- `GET /stats` - Get message statistics
- `WS /ws/can` - WebSocket for real-time messages

#### DBC Support

- `POST /dbc/load` - Load a DBC file
- `GET /dbc/messages` - Get messages from DBC

See [backend/README.md](webserver/backend/README.md) for complete API documentation.

---

## 🧪 Testing

### Test the REST API

```bash
cd webserver/backend
python test_api.py
```

Interactive mode:
```bash
python test_api.py --interactive
```

### Test WebSocket Streaming

```bash
python test_websocket.py
```

### Manual Testing with curl

```bash
# Get devices
curl http://localhost:8000/devices

# Connect
curl -X POST http://localhost:8000/connect \
  -H "Content-Type: application/json" \
  -d '{"device_type":"pcan","channel":"USB1","baudrate":"BAUD_500K"}'

# Send message
curl -X POST http://localhost:8000/send \
  -H "Content-Type: application/json" \
  -d '{"can_id":291,"data":[1,2,3,4,5,6,7,8]}'
```

---

## 🔧 Configuration

Configuration options can be set via environment variables:

```bash
# Server
HOST=0.0.0.0
PORT=8000
RELOAD=True

# CORS (configure for production)
CORS_ORIGINS=http://localhost:3000

# Logging
LOG_LEVEL=info
```

---

## 📁 Project Structure

```
webserver/
├── backend/
│   ├── api.py                 # Main FastAPI application
│   ├── utils.py               # Utility functions
│   ├── (uses ../requirements.txt)  # Python dependencies
│   ├── README.md              # Backend documentation
│   ├── start.bat              # Windows startup script
│   ├── start.sh               # Linux/Mac startup script
│   ├── test_api.py            # REST API test suite
│   └── test_websocket.py      # WebSocket test client
│
└── frontend/                  # Future web frontend
    └── (Coming soon)
```

---

## 🌐 Frontend Development (Next Steps)

The backend is ready for frontend integration. Recommended approaches:

### Option 1: React Frontend
```bash
cd webserver/frontend
npx create-react-app can-explorer
cd can-explorer
npm install axios
```

### Option 2: Vue Frontend
```bash
cd webserver/frontend
npm create vue@latest
```

### Option 3: Vanilla JavaScript
Create a simple `index.html` with WebSocket and fetch API

### Frontend Requirements
- Connect to REST API at `http://localhost:8000`
- Subscribe to WebSocket at `ws://localhost:8000/ws/can`
- Handle real-time message display
- Provide UI for device control and message sending

---

## 🔍 Troubleshooting

### Backend won't start
- Check Python version: `python --version` (need 3.8+)
- Verify dependencies: `pip install -r ../requirements.txt`
- Check port 8000 is available

### Can't connect to PCAN
- Install PCAN driver from PEAK System
- Verify device in Device Manager (Windows)
- Check `python-can` installation

### Can't connect to CANable
- Ensure candleLight firmware is flashed
- Windows: Place `libusb-1.0.dll` in project root
- Linux: Check USB permissions and udev rules
- Verify with `lsusb` (Linux) or Device Manager (Windows)

### WebSocket disconnects
- Check CORS settings in production
- Verify firewall allows WebSocket connections
- Check backend logs for errors

---

## 📝 Development Roadmap

- [x] Python backend with REST API
- [x] WebSocket real-time streaming
- [x] PCAN driver integration
- [x] CANable driver integration
- [x] DBC file support
- [x] Comprehensive testing suite
- [ ] Web frontend (React/Vue/Vanilla)
- [ ] User authentication (optional)
- [ ] Database for message logging
- [ ] Advanced filtering and search
- [ ] Export to CSV/Excel
- [ ] Multi-user support

---

## 📄 License

See [LICENSE](../LICENSE) file in project root.

---

## 🤝 Contributing

Contributions are welcome! The immediate need is:

1. **Web Frontend** - Build a modern UI to replace the Python GUI
2. **Testing** - Additional test coverage
3. **Documentation** - Expand API examples
4. **Features** - Message filtering, advanced statistics, etc.

---

## 📧 Support

For issues or questions:
- Open an issue on GitHub
- Check existing documentation
- Review test scripts for usage examples

---

**Status**: Backend ✅ Complete | Frontend 🚧 Coming Soon

The Python backend is production-ready and waiting for a web frontend!
