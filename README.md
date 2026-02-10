PythonCAN-Utils
===============

CAN bus utility suite with dual adapter support (PCAN-USB, CANable), a FastAPI backend, and a React frontend for real-time CAN communication, DBC decoding, and STM32 firmware flashing.

Features
--------
- Dual adapter support with a shared driver interface (PCAN-USB and CANable).
- FastAPI backend with REST and WebSocket streaming.
- React frontend for live CAN monitoring and basic control.
- DBC upload, persistence, and message decoding.
- STM32 firmware flashing utilities.

Quick start
-----------
One-click start (backend + frontend):

```
python start.py
```

Manual start:

```
cd webserver\backend
python api.py
```

```
cd webserver\frontend
set PORT=3001
npm start
```

Backend runs on port 8000. Frontend runs on port 3001.

Basic functionality
-------------------
- Connect to a CAN adapter and stream messages in real time.
- Send CAN frames (standard or extended IDs).
- Upload a DBC file and decode incoming traffic.
- View decoded signals in the UI.
- Flash STM32 firmware using the provided utilities.

Drivers
-------
Supported adapters share a common API:

```
connect(channel, baudrate)
send_message(can_id, data_bytes, is_extended, is_remote)
start_receive_thread(callback)
disconnect()
```

Tests
-----
```
cd webserver\backend
python test_api.py
```

```
python test_canable.py
python test_can_direct.py
```

