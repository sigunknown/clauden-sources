'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { BrowserWindow, shell } = require('electron');

let runtimeWindow = null;
let starting = null;

function runtimeHome() {
  return process.env.CLAUDEN_RUNTIME_HOME || path.join(os.homedir(), '.clauden', 'runtime');
}

function runtimePort() {
  if (process.env.CLAUDEN_RUNTIME_PORT) return Number(process.env.CLAUDEN_RUNTIME_PORT);
  try {
    const config = JSON.parse(fs.readFileSync(path.join(runtimeHome(), 'config.json'), 'utf8'));
    return Number(config.port) || 47831;
  } catch {
    return 47831;
  }
}

function runtimeToken() {
  try {
    return fs.readFileSync(path.join(runtimeHome(), 'token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function health(timeout = 1200) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(`http://127.0.0.1:${runtimePort()}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function launchCommand() {
  try {
    const launch = JSON.parse(fs.readFileSync(path.join(runtimeHome(), 'launch.json'), 'utf8'));
    if (launch.bin && fs.existsSync(launch.bin)) {
      return { file: launch.node || process.execPath, args: [launch.bin, 'start', '--daemon'] };
    }
  } catch {
    // fallback
  }
  return { file: process.platform === 'win32' ? 'clauden-runtime.cmd' : 'clauden-runtime', args: ['start', '--daemon'] };
}

async function ensureRuntime() {
  if (await health()) return true;
  if (starting) return starting;
  starting = (async () => {
    const command = launchCommand();
    try {
      const child = spawn(command.file, command.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, CLAUDEN_RUNTIME_DAEMON_CHILD: '1' },
      });
      child.on('error', () => {});
      child.unref();
    } catch {
      // проверим health
    }
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (await health()) return true;
    }
    throw new Error('Clauden Runtime не установлен. Скачайте его и выполните clauden-runtime start --daemon');
  })().finally(() => {
    starting = null;
  });
  return starting;
}

async function ticket(workspace = "") {
  await ensureRuntime();
  const token = runtimeToken();
  if (!token) throw new Error('Нет локального токена Clauden Runtime');
  const response = await fetch(`http://127.0.0.1:${runtimePort()}/v1/ui/ticket`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ workspace: workspace || process.env.CLAUDEN_RUNTIME_WORKSPACE || '' }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  return payload.url;
}

async function openRuntimeWindow({ parent = null, workspace = "" } = {}) {
  if (runtimeWindow && !runtimeWindow.isDestroyed()) {
    runtimeWindow.show();
    runtimeWindow.focus();
    return runtimeWindow;
  }
  const url = await ticket(workspace);
  runtimeWindow = new BrowserWindow({
    width: 1080,
    height: 800,
    minWidth: 720,
    minHeight: 500,
    title: 'Clauden Runtime',
    backgroundColor: '#171412',
    show: false,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  runtimeWindow.once('ready-to-show', () => runtimeWindow.show());
  runtimeWindow.on('closed', () => {
    runtimeWindow = null;
  });
  runtimeWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  runtimeWindow.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(`http://127.0.0.1:${runtimePort()}/`)) {
      event.preventDefault();
      if (/^https?:/i.test(target)) shell.openExternal(target);
    }
  });
  await runtimeWindow.loadURL(url);
  return runtimeWindow;
}

module.exports = { openRuntimeWindow };
