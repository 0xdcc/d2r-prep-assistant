'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prep', Object.freeze({
  invoke: (method, payload = {}) => ipcRenderer.invoke('prep:request', method, payload),
  subscribe: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('prep:event', listener);
    return () => ipcRenderer.removeListener('prep:event', listener);
  }
}));
