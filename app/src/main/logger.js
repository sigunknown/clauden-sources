'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Простой файловый лог без секретов: только события и ошибки. */
function createLogger(file) {
  const maxBytes = 2 * 1024 * 1024;
  let ready = false;

  const ensure = () => {
    if (ready) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
        fs.renameSync(file, `${file}.1`);
      }
      ready = true;
    } catch {
      /* ignore */
    }
  };

  const write = (level, message) => {
    const line = `${new Date().toISOString()} ${level} ${String(message).replace(/\s+$/, '')}\n`;
    if (level === 'ERROR') console.error(line.trim());
    else if (level === 'WARN') console.warn(line.trim());
    else console.log(line.trim());
    ensure();
    try {
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch {
      /* ignore */
    }
  };

  return {
    file,
    info: (message) => write('INFO', message),
    warn: (message) => write('WARN', message),
    error: (message) => write('ERROR', message),
  };
}

module.exports = { createLogger };
