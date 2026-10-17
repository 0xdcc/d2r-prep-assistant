'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { runProcess } = require('./process');
const { regularFile } = require('./paths');

const HELPER = path.join(__dirname, 'archive.py');

async function extractArchive(python, filename, destination, options = {}) {
  await regularFile(filename);
  await fs.mkdir(destination, { recursive: false });
  const result = await runProcess(python, ['-I', HELPER, 'extract', filename, destination, String(options.maxBytes || 8 * 1024 ** 3)], options);
  return JSON.parse(result.stdout);
}

async function verifyIpa(python, filename, target, options = {}) {
  await regularFile(filename);
  const spec = path.join(options.cwd, `${crypto.randomUUID()}-verification.json`);
  await fs.writeFile(spec, JSON.stringify({ shellInfo: target.shellInfo, shellManifest: target.shellManifest, minimumOS: target.minimumOS }), { flag: 'wx', mode: 0o600 });
  try {
    const result = await runProcess(python, ['-I', HELPER, options.shellOnly ? 'verify-shell' : 'verify', filename, spec], options);
    return JSON.parse(result.stdout);
  } finally { await fs.rm(spec, { force: true }); }
}

module.exports = { extractArchive, verifyIpa };
