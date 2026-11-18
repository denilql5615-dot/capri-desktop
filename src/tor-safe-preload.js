'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Isolated bridge strictly for tor-safe.html: no shared overlay/hub/agent APIs.
contextBridge.exposeInMainWorld('torSafe', {
  getState: () => ipcRenderer.invoke('tor-safe:state'),
  setEnabled: (on) => ipcRenderer.invoke('tor-safe:set-enabled', Boolean(on)),
  createKey: (passphrase) => ipcRenderer.invoke('tor-safe:create-key', String(passphrase || '')),
  unlock: (passphrase) => ipcRenderer.invoke('tor-safe:unlock', String(passphrase || '')),
  destroyKey: () => ipcRenderer.invoke('tor-safe:destroy-key'),
});
