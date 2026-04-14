import React, { useState, useRef } from 'react';
import { Upload, AlertTriangle, CheckCircle, XCircle, Loader } from 'lucide-react';
import { apiService } from '../services/api';
import './FirmwareFlasher.css';

function FirmwareFlasher({ moduleId, disabled }) {
  const [selectedFile, setSelectedFile] = useState(null);
  const [isFlashing, setIsFlashing] = useState(false);
  const [flashProgress, setFlashProgress] = useState(null);
  const [flashResult, setFlashResult] = useState(null);
  const fileInputRef = useRef(null);

  const handleFileSelect = (event) => {
    const file = event.target.files[0];
    if (file && file.name.endsWith('.bin')) {
      setSelectedFile(file);
      setFlashResult(null);
    } else {
      alert('Please select a .bin file');
      event.target.value = '';
    }
  };

  const handleFlash = async () => {
    if (!selectedFile) {
      alert('Please select a firmware file first');
      return;
    }

    setIsFlashing(true);
    setFlashResult(null);
    setFlashProgress({
      stage: 'upload',
      progress: 0,
      message: 'Uploading firmware...',
      bytes_processed: 0,
      total_bytes: selectedFile.size
    });

    try {
      // Upload firmware file
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('module_number', moduleId);

      console.log('[FLASH] Sending flash request:', {
        fileName: selectedFile.name,
        fileSize: selectedFile.size,
        moduleId: moduleId
      });

      const response = await apiService.flashFirmware(formData, (progressEvent) => {
        if (progressEvent.lengthComputable) {
          const percentComplete = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          setFlashProgress({
            stage: 'upload',
            progress: percentComplete,
            message: 'Uploading firmware...',
            bytes_processed: progressEvent.loaded,
            total_bytes: progressEvent.total
          });
        }
      });

      console.log('[FLASH] Received response:', response);

      if (response.success) {
        setFlashResult({ success: true, message: response.message });
      } else {
        setFlashResult({ success: false, message: response.error || 'Flash failed' });
      }
    } catch (error) {
      console.error('[FLASH] Error:', error);
      console.error('[FLASH] Error response:', error.response);
      setFlashResult({ 
        success: false, 
        message: error.response?.data?.detail || error.message || 'Flash failed' 
      });
    } finally {
      setIsFlashing(false);
    }
  };

  const getStageLabel = (stage) => {
    const stages = {
      'upload': 'Uploading',
      'reset': 'Resetting Module',
      'erase': 'Erasing Flash',
      'write': 'Writing Firmware',
      'verify': 'Verifying',
      'jump': 'Starting Application',
      'complete': 'Complete',
      'error': 'Error'
    };
    return stages[stage] || stage;
  };

  return (
    <div className="firmware-flasher">
      <div className="flasher-header">
        <Upload size={20} />
        <h3>Firmware Update</h3>
      </div>

      <div className="flasher-content">
        {/* File Selection */}
        <div className="file-selector">
          <input
            ref={fileInputRef}
            type="file"
            accept=".bin"
            onChange={handleFileSelect}
            disabled={isFlashing || disabled}
            style={{ display: 'none' }}
          />
          <button
            className="btn-select-file"
            onClick={() => fileInputRef.current?.click()}
            disabled={isFlashing || disabled}
          >
            <Upload size={16} />
            Select Firmware (.bin)
          </button>
          {selectedFile && (
            <div className="selected-file">
              <span className="file-name">{selectedFile.name}</span>
              <span className="file-size">({(selectedFile.size / 1024).toFixed(2)} KB)</span>
            </div>
          )}
        </div>

        {/* Flash Button */}
        <button
          className="btn-flash"
          onClick={handleFlash}
          disabled={!selectedFile || isFlashing || disabled}
        >
          {isFlashing ? (
            <>
              <Loader size={16} className="spinning" />
              Flashing...
            </>
          ) : (
            <>
              <Upload size={16} />
              Flash Module {moduleId}
            </>
          )}
        </button>

        {/* Progress Display */}
        {flashProgress && isFlashing && (
          <div className="flash-progress">
            <div className="progress-header">
              <span className="progress-stage">{getStageLabel(flashProgress.stage)}</span>
              <span className="progress-percent">{flashProgress.progress}%</span>
            </div>
            <div className="progress-bar">
              <div 
                className="progress-fill"
                style={{ width: `${flashProgress.progress}%` }}
              />
            </div>
            <div className="progress-message">{flashProgress.message}</div>
            {flashProgress.total_bytes > 0 && (
              <div className="progress-bytes">
                {(flashProgress.bytes_processed / 1024).toFixed(1)} KB / 
                {(flashProgress.total_bytes / 1024).toFixed(1)} KB
              </div>
            )}
          </div>
        )}

        {/* Result Display */}
        {flashResult && !isFlashing && (
          <div className={`flash-result ${flashResult.success ? 'success' : 'error'}`}>
            {flashResult.success ? (
              <>
                <CheckCircle size={20} />
                <span>{flashResult.message}</span>
              </>
            ) : (
              <>
                <XCircle size={20} />
                <span>{flashResult.message}</span>
              </>
            )}
          </div>
        )}

        {/* Warning */}
        <div className="flasher-warning">
          <AlertTriangle size={14} />
          <span>Flashing will reset the module and interrupt normal operation</span>
        </div>
      </div>
    </div>
  );
}

export default FirmwareFlasher;
