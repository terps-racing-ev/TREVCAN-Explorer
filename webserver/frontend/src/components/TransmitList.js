import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Plus, Trash2, ChevronRight, ChevronDown, Edit2, Play, Square } from 'lucide-react';
import { apiService } from '../services/api';
import './TransmitList.css';

function TransmitList({ dbcFile, onSendMessage }) {
  const [transmitItems, setTransmitItems] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [dbcMessages, setDbcMessages] = useState([]);
  const [editingItem, setEditingItem] = useState(null);
  const [cyclicSending, setCyclicSending] = useState({}); // { itemId: true/false }
  const cyclicIntervalsRef = useRef({}); // Store interval IDs

  // Load transmit list when DBC file changes
  useEffect(() => {
    if (dbcFile) {
      loadTransmitList();
      loadDBCMessages();
    }
  }, [dbcFile]);

  // Load DBC messages for picker
  const loadDBCMessages = async () => {
    try {
      console.log('Loading DBC messages...');
      const response = await apiService.getDBCMessages();
      console.log('DBC messages response:', response);
      if (response.success && response.messages) {
        console.log(`Loaded ${response.messages.length} messages`);
        setDbcMessages(response.messages);
      } else {
        console.error('Invalid response format:', response);
      }
    } catch (error) {
      console.error('Failed to load DBC messages:', error);
      console.error('Error details:', error.response?.data);
    }
  };

  // Load transmit list from backend
  const loadTransmitList = async () => {
    try {
      const response = await apiService.loadTransmitList(dbcFile);
      if (response.success) {
        setTransmitItems(response.items || []);
      }
    } catch (error) {
      console.error('Failed to load transmit list:', error);
    }
  };

  // Save transmit list to backend
  const saveTransmitList = async (items) => {
    try {
      await apiService.saveTransmitList(items, dbcFile);
    } catch (error) {
      console.error('Failed to save transmit list:', error);
    }
  };

  // Handle keyboard events
  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.code === 'Space' && selectedId && !showAddDialog) {
        e.preventDefault();
        const item = transmitItems.find(i => i.id === selectedId);
        if (item) {
          handleSendItem(item);
        }
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [selectedId, transmitItems, showAddDialog]);

  // Send a transmit item
  const handleSendItem = async (item) => {
    try {
      await onSendMessage(item.can_id, item.data, item.is_extended, false);
      console.log(`Sent message: ${item.message_name || `0x${item.can_id.toString(16)}`}`);
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  };

  // Add new item to transmit list
  const handleAddItem = (item) => {
    const newItems = [...transmitItems, item];
    setTransmitItems(newItems);
    saveTransmitList(newItems);
    setShowAddDialog(false);
  };

  // Remove item from transmit list
  const handleRemoveItem = (id) => {
    const newItems = transmitItems.filter(i => i.id !== id);
    setTransmitItems(newItems);
    saveTransmitList(newItems);
    if (selectedId === id) {
      setSelectedId(null);
    }
  };

  // Toggle row expansion
  const toggleExpand = (id) => {
    setExpandedId(expandedId === id ? null : id);
  };

  // Update an existing item in the transmit list
  const handleUpdateItem = (updatedItem) => {
    const newItems = transmitItems.map(item => 
      item.id === updatedItem.id ? updatedItem : item
    );
    setTransmitItems(newItems);
    saveTransmitList(newItems);
    setEditingItem(null);
    setShowAddDialog(false);
  };

  // Toggle cyclic sending for an item
  const toggleCyclicSending = useCallback((item) => {
    const itemId = item.id;
    
    if (cyclicSending[itemId]) {
      // Stop cyclic sending
      if (cyclicIntervalsRef.current[itemId]) {
        clearInterval(cyclicIntervalsRef.current[itemId]);
        delete cyclicIntervalsRef.current[itemId];
      }
      setCyclicSending(prev => ({ ...prev, [itemId]: false }));
      console.log(`Stopped cyclic sending for ${item.message_name || '0x' + item.can_id.toString(16)}`);
    } else {
      // Start cyclic sending
      const cycleTime = item.cycle_time || 100; // Default 100ms
      
      // Send immediately first
      handleSendItem(item);
      
      // Then set up interval
      const intervalId = setInterval(() => {
        handleSendItem(item);
      }, cycleTime);
      
      cyclicIntervalsRef.current[itemId] = intervalId;
      setCyclicSending(prev => ({ ...prev, [itemId]: true }));
      console.log(`Started cyclic sending for ${item.message_name || '0x' + item.can_id.toString(16)} every ${cycleTime}ms`);
    }
  }, [cyclicSending, transmitItems]);

  // Cleanup all intervals on unmount
  useEffect(() => {
    return () => {
      Object.values(cyclicIntervalsRef.current).forEach(intervalId => {
        clearInterval(intervalId);
      });
    };
  }, []);

  // Update cyclic interval when item's cycle_time changes
  useEffect(() => {
    Object.keys(cyclicSending).forEach(itemId => {
      if (cyclicSending[itemId]) {
        const item = transmitItems.find(i => i.id === itemId);
        if (item && cyclicIntervalsRef.current[itemId]) {
          // Clear old interval and set new one with updated cycle time
          clearInterval(cyclicIntervalsRef.current[itemId]);
          const cycleTime = item.cycle_time || 100;
          cyclicIntervalsRef.current[itemId] = setInterval(() => {
            handleSendItem(item);
          }, cycleTime);
        }
      }
    });
  }, [transmitItems]);

  return (
    <div className="transmit-list">
      <div className="transmit-list-header">
        <h4>Transmit List</h4>
        <button className="btn btn-sm btn-primary" onClick={() => setShowAddDialog(true)}>
          <Plus size={12} />
          Add
        </button>
      </div>

      {transmitItems.length === 0 ? (
        <div className="transmit-list-empty">
          No transmit messages. Click "Add" to create one.
        </div>
      ) : (
        <div className="transmit-table-container">
          <table className="transmit-table">
            <thead>
              <tr>
                <th style={{width: '20px'}}></th>
                <th style={{width: '70px'}}>ID</th>
                <th>Name</th>
                <th style={{width: '180px'}}>Data</th>
                <th style={{width: '60px'}}>Cycle</th>
                <th style={{width: '100px'}}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {transmitItems.map(item => {
                const hasSignals = item.signals && Object.keys(item.signals).length > 0;
                const isExpanded = expandedId === item.id;
                
                return (
                  <React.Fragment key={item.id}>
                    <tr 
                      className={`transmit-row ${selectedId === item.id ? 'selected' : ''} ${hasSignals ? 'clickable' : ''}`}
                      onClick={() => {
                        setSelectedId(item.id);
                        if (hasSignals) toggleExpand(item.id);
                      }}
                    >
                      <td className="expand-cell">
                        {hasSignals && (
                          <span className="expand-icon">
                            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </span>
                        )}
                      </td>
                      <td className="id-cell">
                        <span className="hex-id">0x{item.can_id.toString(16).toUpperCase().padStart(3, '0')}</span>
                        {item.is_extended && <span className="ext-badge">EXT</span>}
                      </td>
                      <td className="name-cell">
                        <span className="msg-name">{item.message_name || 'Custom'}</span>
                      </td>
                      <td className="data-cell">
                        <span className="hex-data">
                          {item.data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}
                        </span>
                      </td>
                      <td className="cycle-cell">
                        {item.cycle_time ? (
                          <span className={`cycle-time ${cyclicSending[item.id] ? 'active' : ''}`}>
                            {item.cycle_time}ms
                          </span>
                        ) : (
                          <span className="cycle-time disabled">-</span>
                        )}
                      </td>
                      <td className="actions-cell">
                        {item.cycle_time > 0 && (
                          <button
                            className={`btn btn-icon btn-xs ${cyclicSending[item.id] ? 'btn-cyclic-active' : 'btn-cyclic'}`}
                            onClick={(e) => { e.stopPropagation(); toggleCyclicSending(item); }}
                            title={cyclicSending[item.id] ? 'Stop cyclic sending' : 'Start cyclic sending'}
                          >
                            {cyclicSending[item.id] ? <Square size={12} /> : <Play size={12} />}
                          </button>
                        )}
                        <button
                          className="btn btn-icon btn-xs btn-success"
                          onClick={(e) => { e.stopPropagation(); handleSendItem(item); }}
                          title="Send once"
                        >
                          <Send size={12} />
                        </button>
                        <button
                          className="btn btn-icon btn-xs btn-edit"
                          onClick={(e) => { e.stopPropagation(); setEditingItem(item); setShowAddDialog(true); }}
                          title="Edit"
                        >
                          <Edit2 size={12} />
                        </button>
                        <button
                          className="btn btn-icon btn-xs btn-danger"
                          onClick={(e) => { 
                            e.stopPropagation(); 
                            // Stop cyclic sending if active
                            if (cyclicSending[item.id]) {
                              toggleCyclicSending(item);
                            }
                            handleRemoveItem(item.id); 
                          }}
                          title="Remove"
                        >
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                    {isExpanded && hasSignals && (
                      <tr className="signals-row">
                        <td colSpan="6">
                          <div className="signals-dropdown">
                            <table className="signals-table">
                              <thead>
                                <tr>
                                  <th>Signal</th>
                                  <th>Value</th>
                                </tr>
                              </thead>
                              <tbody>
                                {Object.entries(item.signals).map(([name, value]) => (
                                  <tr key={name}>
                                    <td className="signal-name">{name}</td>
                                    <td className="signal-value">{value}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showAddDialog && (
        <AddTransmitDialog
          dbcMessages={dbcMessages}
          onAdd={handleAddItem}
          onUpdate={handleUpdateItem}
          onCancel={() => { setShowAddDialog(false); setEditingItem(null); }}
          editingItem={editingItem}
        />
      )}

      <div className="transmit-list-hint">
        Space = send selected
      </div>
    </div>
  );
}

// Dialog for adding a new transmit message
function AddTransmitDialog({ dbcMessages, onAdd, onUpdate, onCancel, editingItem }) {
  const isEditing = !!editingItem;
  
  // Determine initial mode based on editing item
  const getInitialMode = () => {
    if (editingItem) {
      return editingItem.message_name ? 'dbc' : 'custom';
    }
    return 'dbc';
  };
  
  const [mode, setMode] = useState(getInitialMode);
  const [selectedMessage, setSelectedMessage] = useState(editingItem?.message_name || '');
  const [customId, setCustomId] = useState(
    editingItem && !editingItem.message_name 
      ? editingItem.can_id.toString(16).toUpperCase() 
      : '123'
  );
  const [customData, setCustomData] = useState(
    editingItem && !editingItem.message_name
      ? editingItem.data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
      : '00 00 00 00 00 00 00 00'
  );
  const [dbcData, setDbcData] = useState(
    editingItem?.message_name
      ? editingItem.data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
      : '00 00 00 00 00 00 00 00'
  );
  const [isExtended, setIsExtended] = useState(editingItem?.is_extended || false);
  const [description, setDescription] = useState(editingItem?.description || '');
  const [signalValues, setSignalValues] = useState(editingItem?.signals || {});
  const [editMode, setEditMode] = useState(
    editingItem?.signals && Object.keys(editingItem.signals).length > 0 ? 'signals' : 'raw'
  );
  const [cycleTime, setCycleTime] = useState(editingItem?.cycle_time || 0);

  const selectedDbcMessage = dbcMessages.find(m => m.name === selectedMessage);

  // Track if we've already initialized for editing
  const hasInitializedEdit = useRef(false);
  
  // Sync cycleTime when editingItem changes (e.g., after page refresh)
  useEffect(() => {
    if (editingItem) {
      setCycleTime(editingItem.cycle_time || 0);
    }
  }, [editingItem]);
  
  // Update dbcData when a DBC message is selected (but not during initial edit load)
  useEffect(() => {
    if (selectedDbcMessage) {
      // If editing and this is the initial load, use the existing values from editingItem
      if (isEditing && !hasInitializedEdit.current && editingItem?.message_name === selectedMessage) {
        hasInitializedEdit.current = true;
        // Restore saved signal values and data from editingItem
        if (editingItem.signals && Object.keys(editingItem.signals).length > 0) {
          setSignalValues(editingItem.signals);
        }
        // Keep the existing dbcData that was set in initial state
        return;
      }
      
      // Only reset values if this is a NEW message selection (not the initial edit load)
      if (!isEditing || hasInitializedEdit.current) {
        // Don't reset if we're just re-rendering with the same message
        if (isEditing && editingItem?.message_name === selectedMessage) {
          return;
        }
        
        const length = selectedDbcMessage.length || 8;
        const zeros = Array(length).fill(0).map(b => '00').join(' ');
        setDbcData(zeros);
        
        // Initialize signal values to 0
        const initialSignals = {};
        if (selectedDbcMessage.signals) {
          selectedDbcMessage.signals.forEach(sig => {
            initialSignals[sig.name] = 0;
          });
        }
        setSignalValues(initialSignals);
      }
    }
  }, [selectedDbcMessage, selectedMessage]);

  // Encode signal values to data bytes
  const encodeSignals = async () => {
    if (!selectedDbcMessage) return null;
    
    try {
      const response = await apiService.encodeMessage(selectedDbcMessage.name, signalValues);
      if (response.success) {
        const hexData = response.data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
        setDbcData(hexData);
        return response; // Return the full response so we can get can_id and is_extended
      }
    } catch (error) {
      console.error('Failed to encode signals:', error);
      alert('Failed to encode signals. Using raw bytes instead.');
    }
    return null;
  };

  const handleSignalChange = (signalName, value) => {
    setSignalValues(prev => ({
      ...prev,
      [signalName]: parseFloat(value) || 0
    }));
  };

  const handleAdd = async () => {
    let item;
    
    if (mode === 'dbc' && selectedDbcMessage) {
      let encodedResponse = null;
      
      // If in signals mode, encode signals first
      if (editMode === 'signals') {
        encodedResponse = await encodeSignals();
      }
      
      // Create message from DBC with manual data bytes
      const dataBytes = dbcData.split(/\s+/).map(b => parseInt(b, 16));
      
      if (dataBytes.some(b => isNaN(b) || b < 0 || b > 255)) {
        alert('Invalid data bytes. Use hex values (00-FF).');
        return;
      }
      
      // Use the encoded response if available, otherwise fall back to selectedDbcMessage
      const canId = encodedResponse ? encodedResponse.can_id : selectedDbcMessage.frame_id;
      const isExt = encodedResponse ? encodedResponse.is_extended : selectedDbcMessage.is_extended;
      
      item = {
        id: isEditing ? editingItem.id : `${Date.now()}-${Math.random()}`,
        can_id: canId,
        data: dataBytes,
        is_extended: isExt,
        message_name: selectedDbcMessage.name,
        signals: editMode === 'signals' ? signalValues : null,
        description: description || `DBC: ${selectedDbcMessage.name}`,
        cycle_time: cycleTime > 0 ? cycleTime : null
      };
    } else {
      // Custom message
      const id = parseInt(customId, 16);
      const dataBytes = customData.split(/\s+/).map(b => parseInt(b, 16));
      
      if (isNaN(id) || dataBytes.some(b => isNaN(b) || b < 0 || b > 255)) {
        alert('Invalid ID or data. Use hex values.');
        return;
      }
      
      item = {
        id: isEditing ? editingItem.id : `${Date.now()}-${Math.random()}`,
        can_id: id,
        data: dataBytes,
        is_extended: isExtended,
        message_name: null,
        signals: null,
        description: description || `Custom message 0x${id.toString(16)}`,
        cycle_time: cycleTime > 0 ? cycleTime : null
      };
    }
    
    if (isEditing) {
      onUpdate(item);
    } else {
      onAdd(item);
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{isEditing ? 'Edit Transmit Message' : 'Add Transmit Message'}</h3>
        </div>
        
        <div className="modal-body">
          <div className="form-group">
            <label>Message Type</label>
            <div className="button-group">
              <button
                className={`btn ${mode === 'dbc' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setMode('dbc')}
              >
                From DBC File
              </button>
              <button
                className={`btn ${mode === 'custom' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setMode('custom')}
              >
                Custom Message
              </button>
            </div>
          </div>

          {mode === 'dbc' ? (
            <>
              <div className="form-group">
                <label>Select Message</label>
                <select
                  value={selectedMessage}
                  onChange={(e) => setSelectedMessage(e.target.value)}
                  className="form-control"
                >
                  <option value="">Choose a message...</option>
                  {dbcMessages.map(msg => (
                    <option key={msg.name} value={msg.name}>
                      {msg.name} (0x{msg.frame_id.toString(16).toUpperCase()})
                    </option>
                  ))}
                </select>
              </div>

              {selectedDbcMessage && (
                <>
                  <div className="message-info">
                    <p><strong>ID:</strong> 0x{selectedDbcMessage.frame_id.toString(16).toUpperCase()}</p>
                    <p><strong>Length:</strong> {selectedDbcMessage.length} bytes</p>
                    <p><strong>Signals:</strong> {selectedDbcMessage.signal_count}</p>
                  </div>

                  {/* Toggle between signal editing and raw bytes */}
                  <div className="form-group">
                    <label>Edit Mode</label>
                    <div className="button-group">
                      <button
                        className={`btn ${editMode === 'signals' ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => setEditMode('signals')}
                      >
                        Edit Signals
                      </button>
                      <button
                        className={`btn ${editMode === 'raw' ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => setEditMode('raw')}
                      >
                        Edit Raw Bytes
                      </button>
                    </div>
                  </div>

                  {editMode === 'signals' ? (
                    <>
                      {selectedDbcMessage.signals && selectedDbcMessage.signals.length > 0 ? (
                        <div className="signals-editor">
                          <label style={{ marginBottom: '10px', display: 'block' }}>Signal Values</label>
                          <div className="signals-list">
                            {selectedDbcMessage.signals.map(signal => {
                              // Check if signal has choices (enumerated values)
                              const hasChoices = signal.choices && Object.keys(signal.choices).length > 0;
                              
                              return (
                                <div key={signal.name} className="signal-input-row">
                                  <label className="signal-label">
                                    <span>{signal.name}</span>
                                    {signal.unit && <span className="signal-unit">{signal.unit}</span>}
                                  </label>
                                  
                                  {hasChoices ? (
                                    // Dropdown for enumerated signals
                                    <select
                                      value={signalValues[signal.name] || 0}
                                      onChange={(e) => handleSignalChange(signal.name, e.target.value)}
                                      className="signal-select"
                                    >
                                      {Object.entries(signal.choices).map(([value, label]) => (
                                        <option key={value} value={value}>
                                          {label} ({value})
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    // Number input for numeric signals
                                    <input
                                      type="number"
                                      value={signalValues[signal.name] || 0}
                                      onChange={(e) => handleSignalChange(signal.name, e.target.value)}
                                      step="any"
                                      className="signal-input"
                                      title={`Min: ${signal.minimum || 'N/A'}, Max: ${signal.maximum || 'N/A'}`}
                                      placeholder="0"
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          <button
                            className="btn btn-secondary btn-block"
                            onClick={encodeSignals}
                            style={{ marginTop: '10px' }}
                          >
                            Preview Encoded Bytes
                          </button>
                        </div>
                      ) : (
                        <p style={{ color: '#999', fontSize: '13px', textAlign: 'center', padding: '20px' }}>
                          No signals defined for this message
                        </p>
                      )}
                    </>
                  ) : null}

                  {/* Show raw bytes input (always visible or when in raw mode) */}
                  {(editMode === 'raw' || editMode === 'signals') && (
                    <div className="form-group">
                      <label>Data Bytes (Hex) {editMode === 'signals' && '(Preview)'}</label>
                      <input
                        type="text"
                        value={dbcData}
                        onChange={(e) => setDbcData(e.target.value)}
                        placeholder="00 00 00 00 00 00 00 00"
                        className="form-control"
                        readOnly={editMode === 'signals'}
                      />
                      {editMode === 'raw' && (
                        <small style={{ color: '#999', fontSize: '11px', marginTop: '4px', display: 'block' }}>
                          Edit the data bytes directly (space-separated hex values)
                        </small>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <div className="form-group">
                <label>CAN ID (Hex)</label>
                <input
                  type="text"
                  value={customId}
                  onChange={(e) => setCustomId(e.target.value)}
                  placeholder="123"
                  className="form-control"
                />
              </div>

              <div className="form-group">
                <label>Data (Hex bytes)</label>
                <input
                  type="text"
                  value={customData}
                  onChange={(e) => setCustomData(e.target.value)}
                  placeholder="00 00 00 00 00 00 00 00"
                  className="form-control"
                />
              </div>

              <div className="form-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={isExtended}
                    onChange={(e) => setIsExtended(e.target.checked)}
                  />
                  Extended ID (29-bit)
                </label>
              </div>
            </>
          )}

          <div className="form-group">
            <label>Description (Optional)</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description..."
              className="form-control"
            />
          </div>

          <div className="form-group">
            <label>Cycle Time (ms) - Set to 0 for manual send only</label>
            <input
              type="number"
              value={cycleTime}
              onChange={(e) => setCycleTime(parseInt(e.target.value) || 0)}
              placeholder="0"
              min="0"
              step="10"
              className="form-control"
            />
            <small style={{ color: '#666', fontSize: '10px', marginTop: '4px', display: 'block' }}>
              Enter a value greater than 0 to enable continuous cyclic sending (e.g., 100 = send every 100ms)
            </small>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleAdd}
            disabled={mode === 'dbc' && !selectedMessage}
          >
            {isEditing ? 'Save Changes' : 'Add to List'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default TransmitList;
