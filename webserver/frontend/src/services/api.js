import axios from 'axios';

// Dynamically determine API base URL
// If REACT_APP_API_URL is set, use it (for custom deployments)
// Otherwise, use the current host (works for localhost and remote access)
const getApiBaseUrl = () => {
  if (process.env.REACT_APP_API_URL) {
    console.log('[API] Using environment variable API URL:', process.env.REACT_APP_API_URL);
    return process.env.REACT_APP_API_URL;
  }
  
  // Use current window location to build API URL
  const protocol = window.location.protocol; // http: or https:
  const host = window.location.hostname; // e.g., localhost or 192.168.1.100
  const port = window.location.port || (protocol === 'https:' ? '443' : '80');
  
  console.log('[API] Current location:', { protocol, host, port });
  
  // If running on dev server (port 3000, 3001, etc.), API is on 8000
  // If running on production (served from backend), use same port
  const apiPort = (port.startsWith('3') || port === '5173') ? '8000' : port;
  
  const url = `${protocol}//${host}:${apiPort}`;
  console.log('[API] Constructed API URL:', url);
  return url;
};

const API_BASE_URL = getApiBaseUrl();
console.log('[API] Final API base URL:', API_BASE_URL);

class ApiService {
  constructor() {
    this.client = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  async getDevices() {
    const response = await this.client.get('/devices');
    return response.data;
  }

  async connect(deviceType, channel, baudrate) {
    const response = await this.client.post('/connect', {
      device_type: deviceType,
      channel: channel,
      baudrate: baudrate,
    });
    return response.data;
  }

  async disconnect() {
    const response = await this.client.post('/disconnect');
    return response.data;
  }

  async getStatus() {
    const response = await this.client.get('/status');
    return response.data;
  }

  async getHealth() {
    const response = await this.client.get('/health');
    return response.data;
  }

  async requestBackendShutdown() {
    const response = await this.client.post('/shutdown');
    return response.data;
  }

  getBaseUrl() {
    return this.client.defaults.baseURL;
  }

  async sendMessage(canId, data, isExtended = false, isRemote = false) {
    const response = await this.client.post('/send', {
      can_id: canId,
      data: data,
      is_extended: isExtended,
      is_remote: isRemote,
    });
    return response.data;
  }

  async getStats() {
    const response = await this.client.get('/stats');
    return response.data;
  }

  async startSimulation() {
    const response = await this.client.post('/simulation/start');
    return response.data;
  }

  async stopSimulation() {
    const response = await this.client.post('/simulation/stop');
    return response.data;
  }

  async getSimulationStatus() {
    const response = await this.client.get('/simulation/status');
    return response.data;
  }

  async uploadDBC(file) {
    const formData = new FormData();
    formData.append('file', file);
    
    const response = await this.client.post('/dbc/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  }

  async getCurrentDBC() {
    const response = await this.client.get('/dbc/current');
    return response.data;
  }

  async listDBCFiles() {
    const response = await this.client.get('/dbc/list');
    return response.data;
  }

  async deleteDBC(filename) {
    const response = await this.client.delete(`/dbc/delete/${filename}`);
    return response.data;
  }

  async loadDBC(filePath) {
    const response = await this.client.post('/dbc/load', {
      file_path: filePath,
    });
    return response.data;
  }

  async getDBCMessages() {
    const response = await this.client.get('/dbc/messages');
    return response.data;
  }

  async saveTransmitList(items, dbcFile) {
    const response = await this.client.post('/transmit_list/save', {
      items: items,
      dbc_file: dbcFile,
    });
    return response.data;
  }

  async loadTransmitList(dbcFile) {
    const response = await this.client.get('/transmit_list/load', {
      params: { dbc_file: dbcFile },
    });
    return response.data;
  }

  async encodeMessage(messageName, signals) {
    const response = await this.client.post('/dbc/encode_message', null, {
      params: { 
        message_name: messageName,
        signals: JSON.stringify(signals)
      },
    });
    return response.data;
  }

  async flashFirmware(formData, onUploadProgress) {
    const response = await this.client.post('/flash_firmware', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      onUploadProgress: onUploadProgress,
      timeout: 300000, // 5 minute timeout for flash operation
    });
    return response.data;
  }
}

export const apiService = new ApiService();
