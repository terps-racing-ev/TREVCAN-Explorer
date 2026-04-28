export const formatCanableDeviceLabel = (device) => {
  const index = Number.isFinite(Number(device?.index)) ? Number(device.index) : 0;
  const description = (device?.description || '').trim() || `CANable device ${index}`;
  return `Device ${index}: ${description}`;
};

export const normalizeCanableChannel = (channel) => {
  if (channel === null || channel === undefined) {
    return '';
  }

  const channelString = String(channel).trim();
  if (!channelString) {
    return '';
  }

  if (/^\d+$/.test(channelString)) {
    return channelString;
  }

  const deviceMatch = channelString.match(/device\s+(\d+)/i);
  if (deviceMatch) {
    return deviceMatch[1];
  }

  return channelString.replace(/\D/g, '');
};

export const getDefaultChannelForDeviceType = (deviceType, devices) => {
  if (deviceType === 'pcan') {
    const firstPcan = devices.find(device => device.device_type === 'pcan');
    return firstPcan?.name || 'USB1';
  }

  if (deviceType === 'canable') {
    const firstCanable = devices.find(device => device.device_type === 'canable');
    return firstCanable ? String(firstCanable.index) : '0';
  }

  return '';
};
