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
The repository includes a systemd installer that creates two services for the
current checkout and enables them at boot:

- `trevcan-socketcan.service` normalizes CAN interface names before the app starts.
- `trevcan-explorer.service` starts the TREVCAN backend/frontend stack after SocketCAN is ready.

On a Raspberry Pi with a 2-channel CAN HAT, the installer reserves `can0` and
`can1` for the onboard SPI controllers, then assigns removable USB adapters in
priority order starting at `can2`:

- PCAN-USB -> `can2`
- CANable/gs_usb -> `can3`

If only one USB adapter is attached, it is assigned to `can2`.

1. Install the service:
	```
	bash systemd/install_service.sh
	```
   To use a different default USB CAN bitrate during boot bring-up:
	```
	TREVCAN_SOCKETCAN_BITRATE=250000 bash systemd/install_service.sh
	```
2. Check status:
	```
	sudo systemctl status trevcan-socketcan.service
	sudo systemctl status trevcan-explorer.service
	```
3. View logs:
	```
	sudo journalctl -u trevcan-socketcan.service -f
	sudo journalctl -u trevcan-explorer.service -f
	```

The service runs `python3 start.py --service`, which keeps the backend and
frontend running without trying to open a browser during boot.

On Linux, removable USB CAN adapters brought up by `trevcan-socketcan.service`
will appear to the app as SocketCAN devices. Use the SocketCAN/CANable path in
the UI and select the interface mapped to `can2` or `can3`.

Open:
- Frontend: http://localhost:3001
- Backend API: http://localhost:8000

Supported CAN hardware / servers
--------------------------------
- PCAN-USB
- CANable
- Network CAN server (`host:port`)
- Bluetooth CAN server (Windows)

