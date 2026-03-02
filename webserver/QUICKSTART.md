# 🚀 Quick Start Guide - CAN Backend

## Start Backend Server

### Windows
```bash
cd webserver\backend
start.bat
```

### Linux/Mac
```bash
cd webserver/backend
chmod +x start.sh
./start.sh
```

### Manual Start
```bash
cd webserver/backend
pip install -r ../../requirements.txt
python api.py
```

---

## Access Points

- **API**: http://localhost:8000
- **Swagger Docs**: http://localhost:8000/docs
- **ReDoc**: http://localhost:8000/redoc
- **WebSocket**: ws://localhost:8000/ws/can

---

## Quick Test

```bash
# Terminal 1 - Start backend
cd webserver/backend
python api.py

# Terminal 2 - Test API
python test_api.py

# Terminal 3 - Monitor WebSocket
python test_websocket.py
```

---

## Essential curl Commands

```bash
# List devices
curl http://localhost:8000/devices

# Connect to PCAN
curl -X POST http://localhost:8000/connect \
  -H "Content-Type: application/json" \
  -d '{"device_type":"pcan","channel":"USB1","baudrate":"BAUD_500K"}'

# Send message
curl -X POST http://localhost:8000/send \
  -H "Content-Type: application/json" \
  -d '{"can_id":291,"data":[1,2,3,4,5,6,7,8]}'

# Status
curl http://localhost:8000/status

# Stats
curl http://localhost:8000/stats

# Disconnect
curl -X POST http://localhost:8000/disconnect
```

---

## WebSocket Example (JavaScript)

```javascript
const ws = new WebSocket('ws://localhost:8000/ws/can');

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log(`ID: 0x${msg.id.toString(16)}, Data:`, msg.data);
};
```

---

## File Structure

```
webserver/backend/
├── api.py              # Main backend
├── utils.py            # Helpers
├── (uses ../../requirements.txt)    # Dependencies
├── test_api.py         # REST tests
├── test_websocket.py   # WS tests
├── start.bat/sh        # Startup scripts
└── README.md           # Full docs
```

---

## Next: Build Frontend

```bash
# React
npx create-react-app frontend
cd frontend
npm install axios
npm start

# Vue
npm create vue@latest frontend
cd frontend
npm install axios
npm run dev

# Vanilla JS
# Create index.html and use fetch() + WebSocket
```

---

## Common Issues

**Port 8000 in use:**
```bash
# Change port in api.py or:
uvicorn api:app --port 8001
```

**Import errors:**
```bash
pip install -r ../../requirements.txt
```

**CANable not found:**
- Windows: Add libusb-1.0.dll to project root
- Linux: `sudo usermod -a -G plugdev $USER`

**CORS errors:**
- Update CORS_ORIGINS in api.py

---

## Support

- 📖 Full docs: `webserver/backend/README.md`
- 📋 Complete guide: `webserver/BACKEND_COMPLETE.md`
- 🔧 API docs: http://localhost:8000/docs (when running)

---

**Status**: ✅ Backend Complete | 🚧 Frontend Coming Soon
