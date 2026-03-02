TREVCAN-Explorer
================

Simple CAN explorer with a FastAPI backend and React frontend.

Quick start
-----------
1. Install Python deps:
	```
	pip install -r requirements.txt
	```
2. Install frontend deps:
	```
	cd webserver/frontend
	npm install
	cd ../..
	```
3. Start everything:
	```
	python start.py
	```

Open:
- Frontend: http://localhost:3001
- Backend API: http://localhost:8000

Supported CAN hardware / servers
--------------------------------
- PCAN-USB
- CANable
- Network CAN server (`host:port`)
- Bluetooth CAN server (Windows)

