# TREVCAN-Explorer — Project Guidelines

CAN bus explorer for Terps Racing EV. FastAPI backend + React frontend with real-time WebSocket streaming, DBC-based message decoding, and multiple CAN hardware drivers.

## Architecture

```
start.py                 # Unified launcher (backend + frontend + browser)
drivers/                 # CAN hardware abstraction (PCAN, CANable, Network, Bluetooth)
webserver/
  backend/               # FastAPI (Python) — REST + WebSocket on :8000
    api.py               # All routes, CANBackend singleton, WebSocket broadcast
    utils.py             # DBC helpers, CAN ID parsing
    dbc_files/           # Uploaded DBC files + dbc_config.json
    transmit_lists/      # Persisted transmit queues (JSON, SHA-keyed)
  frontend/              # React 18 (CRA) on :3000
    src/components/      # Functional components (hooks, no class components)
    src/services/        # api.js (axios singleton), websocket.js (auto-reconnect)
```

**Key patterns:**
- `CANBackend` in `api.py` is a global singleton holding driver state, DBC database, WebSocket connections, and stats
- WebSocket (`/ws/can`) broadcasts to all clients; frontend buffers messages in a ref and flushes every 100ms
- Multi-DBC support: `dbc_config.json` tracks enabled files and priority; only one effective DBC at a time
- Drivers share a common interface but have no formal base class — each implements `connect()`, `disconnect()`, `send()`, `receive()`

## Build and Test

```bash
# Full stack (starts backend + frontend + opens browser)
python start.py

# Backend only
cd webserver/backend
uvicorn api:app --reload --host 0.0.0.0 --port 8000

# Frontend only
cd webserver/frontend
npm install   # first time
npm start     # dev server on :3000
npm run build # production build → build/
```

**Tests:** Backend tests in `webserver/backend/test_*.py` use raw `requests` (not pytest). Run manually: `python test_api.py`. No frontend test files yet.

## Conventions

- **Python:** snake_case for variables/functions, PascalCase for classes and enums
- **JavaScript:** camelCase for variables/functions, PascalCase for components
- **CSS:** kebab-case class names, one `.css` per component, no CSS modules or preprocessors
- **CAN IDs:** Always hex format `0x123`; DBC signals are 1-indexed (e.g., `BMS1_Cell1_Bal`), UI arrays are 0-based — subtract 1 when mapping
- **No TypeScript, no linter config, no formatter config** — CRA defaults only

## Gotchas

- CANable on Windows: `libusb-1.0.dll` must be loaded before importing python-can (see `CANable_Driver.py`)
- Frontend auto-detects API URL at runtime (dev :3000 proxies to :8000, production same-origin on :8000)
- WebSocket reconnect pauses when document is hidden; heartbeat timeout is 10s
- Firmware flash endpoint has a 5-minute timeout
- Tab presence tracked in localStorage with 5s heartbeat — do not send `/disconnect` on tab unload if sibling tabs exist
- Current sensor frame `0xCC` must be simulated on its own 10ms task, not on the slower module telemetry loop

## Docs

- [README.md](../README.md) — Quick start and supported hardware
- [webserver/backend/README.md](../webserver/backend/README.md) — Full API endpoint reference and setup
- [webserver/frontend/README.md](../webserver/frontend/README.md) — Component overview and feature list
