'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
ipcRenderer.on('claude:event', (_event, payload) => {
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch {
      /* renderer listener must not break the bridge */
    }
  }
});

const customListeners = new Set();
ipcRenderer.on('customApi:event', (_event, payload) => {
  for (const listener of customListeners) {
    try {
      listener(payload);
    } catch {
      /* renderer listener must not break the bridge */
    }
  }
});

const updateListeners = new Set();
ipcRenderer.on('update:event', (_event, payload) => {
  for (const listener of updateListeners) {
    try {
      listener(payload);
    } catch {
      /* renderer listener must not break the bridge */
    }
  }
});

const proxyListeners = new Set();
ipcRenderer.on('proxy:event', (_event, payload) => {
  for (const listener of proxyListeners) {
    try {
      listener(payload);
    } catch {
      /* renderer listener must not break the bridge */
    }
  }
});

contextBridge.exposeInMainWorld('claudenDesktop', {
  isDesktop: true,
  platform: process.platform,
  claude: {
    status: (options) => ipcRenderer.invoke('claude:status', options),
    login: () => ipcRenderer.invoke('claude:login'),
    logout: () => ipcRenderer.invoke('claude:logout'),
    refresh: () => ipcRenderer.invoke('claude:refresh'),
    desktop: () => ipcRenderer.invoke('claude:desktop/status'),
    importDesktop: (options) => ipcRenderer.invoke('claude:desktop/import', options),
    models: () => ipcRenderer.invoke('claude:models'),
    exitIp: () => ipcRenderer.invoke('claude:exit-ip'),
    start: (payload) => ipcRenderer.invoke('claude:start', payload),
    stop: (streamId) => ipcRenderer.invoke('claude:stop', streamId),
    download: (file) => ipcRenderer.invoke('claude:download', file),
    importList: (options) => ipcRenderer.invoke('claude:import/list', options),
    importOne: (summary) => ipcRenderer.invoke('claude:import/one', summary),
    onEvent: (listener) => {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
  customApi: {
    list: () => ipcRenderer.invoke('customApi:list'),
    get: (id) => ipcRenderer.invoke('customApi:get', id),
    save: (payload) => ipcRenderer.invoke('customApi:save', payload),
    remove: (id) => ipcRenderer.invoke('customApi:remove', id),
    test: (payload) => ipcRenderer.invoke('customApi:test', payload),
    start: (payload) => ipcRenderer.invoke('customApi:start', payload),
    stop: (streamId) => ipcRenderer.invoke('customApi:stop', streamId),
    onEvent: (listener) => {
      if (typeof listener !== 'function') return () => {};
      customListeners.add(listener);
      return () => customListeners.delete(listener);
    },
  },
  proxy: {
    state: () => ipcRenderer.invoke('proxy:state'),
    ownExit: () => ipcRenderer.invoke('proxy:own-exit'),
    refresh: () => ipcRenderer.invoke('proxy:refresh'),
    subscribe: (payload) => ipcRenderer.invoke('proxy:subscribe', payload),
    select: (id) => ipcRenderer.invoke('proxy:select', id),
    connect: (id) => ipcRenderer.invoke('proxy:connect', id),
    disconnect: () => ipcRenderer.invoke('proxy:disconnect'),
    ping: (id) => ipcRenderer.invoke('proxy:ping', id),
    autostart: (value) => ipcRenderer.invoke('proxy:autostart', value),
    onEvent: (listener) => {
      if (typeof listener !== 'function') return () => {};
      proxyListeners.add(listener);
      return () => proxyListeners.delete(listener);
    },
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    openBrowser: (url) => ipcRenderer.invoke('app:openBrowser', url),
    captureOAuth: (payload) => ipcRenderer.invoke('oauth:capture', payload),
    openLogs: () => ipcRenderer.invoke('app:openLogs'),
    retry: () => ipcRenderer.invoke('app:retry'),
  },
  local: {
    pickFolder: () => ipcRenderer.invoke('local:pickFolder'),
    blankRoot: () => ipcRenderer.invoke('local:blankRoot'),
    list: (root, dir) => ipcRenderer.invoke('local:list', { root, dir }),
    read: (root, file) => ipcRenderer.invoke('local:read', { root, file }),
    write: (root, file, content) => ipcRenderer.invoke('local:write', { root, file, content }),
  },
  updates: {
    status: () => ipcRenderer.invoke('update:status'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onEvent: (listener) => {
      if (typeof listener !== 'function') return () => {};
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    },
  },
});
