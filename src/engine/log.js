'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { directory } = require('./paths');

async function exportNewLog(folder, contents) {
  const destination = path.join(await directory(folder), `d2r-prep-${crypto.randomUUID()}.log`);
  await fs.promises.writeFile(destination, contents, { flag: 'wx', mode: 0o600 });
  return destination;
}

function redact(text, paths = []) {
  let output = String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  for (const candidate of [...paths, os.homedir()].filter(Boolean).sort((first, second) => second.length - first.length)) output = output.split(candidate).join('[LOCAL_PATH]');
  output = output.replace(/https?:\/\/[^\s<>]+/gi, '[URL]');
  output = output.replace(/((?:token|password|authorization|api[_-]?key|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
  return output.slice(-16000);
}

class JobLog {
  constructor(filename, paths, onLine) {
    this.filename = filename;
    this.paths = paths;
    this.onLine = onLine;
    this.lines = [];
    this.bytes = 0;
    this.limit = 4 * 1024 * 1024;
    fs.writeFileSync(filename, '', { flag: 'wx', mode: 0o600 });
  }

  append(message) {
    const line = `${new Date().toISOString()} ${redact(message, this.paths)}`;
    this.lines.push(line);
    if (this.lines.length > 250) this.lines.shift();
    if (this.bytes < this.limit) {
      const bytes = Buffer.from(`${line}\n`).subarray(0, this.limit - this.bytes);
      fs.appendFileSync(this.filename, bytes);
      this.bytes += bytes.length;
    }
    this.onLine?.(line);
  }
}

module.exports = { redact, JobLog, exportNewLog };
