'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const { PrepError, assert } = require('./errors');

function childEnvironment(temp, additions = {}) {
  const environment = {};
  const allowed = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'ProgramFiles', 'ProgramFiles(x86)', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE'];
  for (const key of allowed) if (process.env[key]) environment[key] = process.env[key];
  const result = { ...environment, TMP: temp, TEMP: temp, TMPDIR: temp, OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2', MKL_NUM_THREADS: '2', NUMEXPR_NUM_THREADS: '2', VECLIB_MAXIMUM_THREADS: '2', CMAKE_BUILD_PARALLEL_LEVEL: '2', CARGO_BUILD_JOBS: '2', DOTNET_PROCESSOR_COUNT: '2', MSBUILDMAXCPUCOUNT: '2', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', ...additions };
  if (process.platform === 'win32') {
    // Windows environment names are case-insensitive. Emit one unambiguous PATH.
    const pathKey = Object.keys(additions).find(key => key.toUpperCase() === 'PATH');
    const value = pathKey === undefined ? (environment.PATH ?? environment.Path) : additions[pathKey];
    for (const key of Object.keys(result)) if (key.toUpperCase() === 'PATH') delete result[key];
    if (value !== undefined) result.PATH = value;
  }
  return result;
}

async function executable(names, searchPath = process.env.PATH || process.env.Path || '') {
  for (const name of names) {
    for (const folder of searchPath.split(path.delimiter).filter(Boolean)) {
      const candidate = path.resolve(folder, process.platform === 'win32' ? `${name}.exe` : name);
      try {
        const info = await fs.stat(candidate);
        if (info.isFile()) {
          await fs.access(candidate, require('node:fs').constants.X_OK);
          return candidate;
        }
      } catch { /* absent executable candidates are expected */ }
    }
  }
  return null;
}

function runProcess(command, args, { cwd, temp = cwd, signal, onLog = () => {}, environment = {}, timeoutMs = 30 * 60 * 1000, maxCapture = 256 * 1024 } = {}) {
  assert(path.isAbsolute(command) && Array.isArray(args) && args.every(argument => typeof argument === 'string' && !argument.includes('\0')), 'PROCESS_ARGS', 'Only absolute internally resolved executables and string arguments are allowed.');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: childEnvironment(temp, environment), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let failure = null;
    let timer;
    let killTimer;
    let killer = null;
    let finalized = false;
    let exited = false;
    const killTree = force => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        if (exited || child.exitCode !== null || child.signalCode !== null) return;
        if (!killer) {
          const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
          killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => { if (!exited) child.kill(); });
        }
      } else {
        try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
      }
    };
    const abort = () => {
      if (exited) return;
      failure = new PrepError('CANCELLED', 'Operation cancelled; child processes stopped.');
      killTree(false);
      killTimer = setTimeout(() => killTree(true), 600);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => {
      if (exited) return;
      failure = new PrepError('PROCESS_TIMEOUT', 'A subprocess exceeded its time limit.');
      killTree(true);
    }, timeoutMs);
    const capture = (chunk, stream) => {
      const text = chunk.toString('utf8');
      if (stream === 'stdout') stdout = (stdout + text).slice(-maxCapture);
      else stderr = (stderr + text).slice(-maxCapture);
      onLog(text.slice(-16000));
    };
    child.stdout.on('data', chunk => capture(chunk, 'stdout'));
    child.stderr.on('data', chunk => capture(chunk, 'stderr'));
    const complete = async (error, code) => {
      if (finalized) return;
      finalized = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (failure && process.platform !== 'win32') killTree(true);
      if (killer && killer.exitCode === null) await new Promise(done => { killer.once('close', done); setTimeout(done, 3000); });
      if (failure) reject(failure);
      else if (error) reject(new PrepError('PROCESS_START', `Cannot start ${path.basename(command)}: ${error.message}`));
      else if (code !== 0) reject(new PrepError('PROCESS_EXIT', `${path.basename(command)} exited with code ${code}.\n${stderr.slice(-4000)}`));
      else resolve({ stdout, stderr, code });
    };
    child.once('error', error => complete(error));
    child.once('exit', () => { exited = true; });
    child.once('close', code => complete(null, code));
  });
}

module.exports = { executable, childEnvironment, runProcess };
