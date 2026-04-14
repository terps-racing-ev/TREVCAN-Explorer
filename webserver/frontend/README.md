# CAN Explorer Frontend

Modern React-based web frontend for the CAN Communication Tool.

## Features

✨ **Modern UI** - Beautiful gradient design with dark theme
🚀 **Real-time Updates** - WebSocket integration for live CAN messages
📊 **Multi-View Support** - CAN Explorer, Thermistor Monitor, Cell Voltage Monitor
🎨 **Responsive Design** - Works on desktop, tablet, and mobile
⚡ **Fast Performance** - Optimized React components with useMemo
🔌 **Easy Integration** - Connects seamlessly to Python backend

## Quick Start

### Prerequisites

- Node.js 14+ (https://nodejs.org/)
- npm (comes with Node.js)
- Backend API running at http://localhost:8000

### Installation

```bash
# Install dependencies
npm install
```

### Development

```bash
# Start development server (Windows)
start.bat

# Start development server (Linux/Mac)
chmod +x start.sh
./start.sh

# Or use npm directly
npm start
```

The frontend will be available at **http://localhost:3000**

### Production Build

```bash
# Create optimized production build
npm run build

# The build folder will contain the production-ready files
# Serve with any static file server (nginx, Apache, etc.)
```

## Architecture

```
frontend/
├── public/
│   └── index.html          # HTML template
├── src/
│   ├── components/         # React components
│   │   ├── Header.js/css
│   │   ├── ConnectionPanel.js/css
│   │   ├── CANExplorer.js/css
│   │   ├── ThermistorMonitor.js/css
│   │   ├── CellVoltageMonitor.js/css
│   │   └── StatusBar.js/css
│   ├── services/           # API integration
│   │   ├── api.js         # REST API calls
│   │   └── websocket.js   # WebSocket connection
│   ├── App.js             # Main application
│   ├── App.css            # Global styles
│   ├── index.js           # React entry point
│   └── index.css          # Base styles
├── package.json           # Dependencies
└── README.md             # This file
```

## Features Overview

### 1. CAN Explorer Tab

- **Device Connection** - Connect to PCAN or CANable devices
- **Message Sending** - Send custom CAN messages
- **Message Table** - View all received messages with filtering
- **DBC Support** - Load DBC files for automatic message decoding
- **Real-time Updates** - Live message streaming via WebSocket

### 2. Thermistor Monitor Tab

- **336 Channels** - Monitor 6 modules × 56 thermistors
- **Color Coding** - Visual temperature indication
- **Statistics** - Min, max, average temperatures
- **Interactive Grid** - Hover for detailed information

### 3. Cell Voltage Monitor Tab

- **108 Cells** - Monitor 6 modules × 18 cells
- **Stack Voltage** - Total battery pack voltage
- **Color Coding** - Visual voltage level indication
- **Statistics** - Min, max, average, delta voltages

## Configuration

### Backend URL

By default, the frontend connects to `http://localhost:8000`. To change this:

Create a `.env` file in the frontend directory:

```bash
REACT_APP_API_URL=http://your-backend-url:8000
REACT_APP_WS_URL=ws://your-backend-url:8000/ws/can
```

### CORS

The backend is configured to allow all origins in development. For production:

1. Update backend CORS settings in `backend/api.py`
2. Specify your frontend domain

## Components

### Header
Application title and branding with animated logo.

### ConnectionPanel
Device selection, connection controls, and status indicator.

### CANExplorer
- Send CAN messages
- View received messages in a table
- Load and use DBC files
- Filter messages by ID or data
- Real-time message updates

### ThermistorMonitor
- Grid view of all 336 thermistors across 6 modules
- Color-coded temperature display
- Statistics dashboard
- Hover tooltips for detailed info

### CellVoltageMonitor
- Grid view of all 108 cells across 6 modules
- Color-coded voltage levels
- Stack voltage display
- Statistics dashboard

### StatusBar
Connection status, message count, rate, and uptime display.

## Styling

The application uses a modern dark theme with:

- **Primary Color**: Purple/Blue gradient (#667eea to #764ba2)
- **Background**: Dark gradient (#1a1a2e to #16213e)
- **Cards**: Semi-transparent with borders
- **Typography**: Segoe UI with Consolas for code/hex
- **Animations**: Smooth transitions and hover effects

All components are fully responsive and work on mobile devices.

## API Integration

### REST API (services/api.js)

- `getDevices()` - Get available CAN devices
- `connect(deviceType, channel, baudrate)` - Connect to device
- `disconnect()` - Disconnect from device
- `getStatus()` - Get connection status
- `sendMessage(canId, data, isExtended, isRemote)` - Send CAN message
- `getStats()` - Get message statistics
- `loadDBC(filePath)` - Load DBC file
- `getDBCMessages()` - Get DBC message definitions

### WebSocket (services/websocket.js)

- Real-time CAN message streaming
- Auto-reconnect on disconnect
- Heartbeat support
- Message parsing and distribution

## Development Tips

### Hot Reload

Changes to source files will automatically reload the browser.

### DevTools

React DevTools extension recommended for debugging:
- Chrome: https://chrome.google.com/webstore/detail/react-developer-tools
- Firefox: https://addons.mozilla.org/en-US/firefox/addon/react-devtools/

### Performance

The application uses `useMemo` and `useCallback` for optimization:
- Message aggregation is memoized
- Statistics calculations are memoized
- WebSocket callbacks are memoized

### Debugging

Open browser console (F12) to see:
- WebSocket connection status
- API calls and responses
- Error messages

## Deployment

### Static Hosting

1. Build the production bundle:
   ```bash
   npm run build
   ```

2. Deploy the `build` folder to:
   - **Netlify**: Drag and drop the build folder
   - **Vercel**: `vercel deploy`
   - **GitHub Pages**: Use `gh-pages` package
   - **AWS S3**: Upload to S3 bucket with static hosting
   - **Nginx/Apache**: Copy to web server directory

### Environment Variables

For production, set:

```bash
REACT_APP_API_URL=https://your-backend-domain.com
REACT_APP_WS_URL=wss://your-backend-domain.com/ws/can
```

## Troubleshooting

### Backend Connection Failed

- Ensure backend is running at http://localhost:8000
- Check CORS settings in backend
- Verify network connectivity

### WebSocket Not Connecting

- Check backend WebSocket endpoint is accessible
- Verify firewall allows WebSocket connections
- Check browser console for errors

### Build Errors

```bash
# Clear node_modules and reinstall
rm -rf node_modules package-lock.json
npm install
```

### Port 3000 Already in Use

```bash
# Use a different port (Windows)
set PORT=3001 && npm start

# Use a different port (Linux/Mac)
PORT=3001 npm start
```

## Browser Support

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## License

See project root LICENSE file.

## Contributing

Contributions welcome! Areas for improvement:

- [ ] Add chart visualizations (using recharts)
- [ ] Export data to CSV
- [ ] Dark/light theme toggle
- [ ] Message history with search
- [ ] Advanced filtering options
- [ ] Customizable layouts
- [ ] User preferences saving
- [ ] Multi-language support

---

**Ready to use!** Start the backend, then start the frontend, and enjoy your modern CAN communication tool! 🚀
