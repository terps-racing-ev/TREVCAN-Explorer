TREVCAN-Explorer
================

Simple CAN explorer with a FastAPI backend and React frontend.

It can be used as a general purpose replacement for PCAN-Explorer in addition
to a TREV specific menus and pages. 

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

Run on boot with systemd (Linux)
---------------------------------
The repository includes a systemd installer that creates a service for the
current checkout and enables it at boot.

1. Install the service:
	```
	bash systemd/install_service.sh
	```
2. Check status:
	```
	sudo systemctl status trevcan-explorer.service
	```
3. View logs:
	```
	sudo journalctl -u trevcan-explorer.service -f
	```

The service runs `python3 start.py --service`, which keeps the backend and
frontend running without trying to open a browser during boot.

Open:
- Frontend: http://localhost:3001
- Backend API: http://localhost:8000

Supported CAN hardware / servers
--------------------------------
- PCAN-USB
- CANable
- Network CAN server (`host:port`)
- Bluetooth CAN server (Windows)

