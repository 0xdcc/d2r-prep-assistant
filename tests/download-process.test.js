'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { temporary, manifest } = require('./helpers');
const { downloadVerified } = require('../src/engine/download');
const { runProcess, childEnvironment } = require('../src/engine/process');
const { JobEngine } = require('../src/engine/jobs');

test('Windows lifecycle never calls taskkill after normal or nonzero child exit', async context => {
  const root = await temporary(context);
  const script = `
    const assert = require('node:assert/strict');
    const processes = require('node:child_process');
    const spawn = processes.spawn;
    let taskkills = 0;
    processes.spawn = (command, ...args) => {
      if (command.endsWith('taskkill.exe')) taskkills += 1;
      return spawn(command, ...args);
    };
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { runProcess } = require(${JSON.stringify(path.resolve(__dirname, '../src/engine/process'))});
    (async () => {
      assert.equal((await runProcess(process.execPath, ['-e', 'process.exit(0)'], { cwd: process.cwd() })).code, 0);
      await assert.rejects(runProcess(process.execPath, ['-e', 'process.exit(7)'], { cwd: process.cwd() }), { code: 'PROCESS_EXIT' });
      assert.equal(taskkills, 0);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  await runProcess(process.execPath, ['-e', script], { cwd: root });
});

test('Windows child PATH has one spelling and preserves managed precedence without global mutation', async context => {
  const root = await temporary(context);
  const script = `
    const assert = require('node:assert/strict');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.Path = 'system-path';
    process.env.PATH = 'inherited-path';
    const { childEnvironment } = require(${JSON.stringify(path.resolve(__dirname, '../src/engine/process'))});
    for (const additions of [{ PATH: 'managed-path' }, { Path: 'managed-path' }]) {
      const result = childEnvironment(process.cwd(), additions);
      assert.deepEqual(Object.keys(result).filter(k => k.toUpperCase() === 'PATH'), ['PATH']);
      assert.equal(result.PATH, 'managed-path');
    }
    assert.equal(process.env.PATH, 'inherited-path');
    assert.equal(process.env.Path, 'system-path');
  `;
  await runProcess(process.execPath, ['-e', script], { cwd: root });
});

test('timeout stops an actual live subprocess', async context => {
  const root = await temporary(context);
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, timeoutMs: 100 }), { code: 'PROCESS_TIMEOUT' });
});

const record = bytes => ({ url: 'https://github.com/owner/project/releases/download/v1/synthetic.zip', sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, license: 'Synthetic test protocol' });

test('download hash mismatch is rejected and no partial artifact survives', async context => {
  const root = await temporary(context); const pin = record(Buffer.from('good'));
  await assert.rejects(downloadVerified(pin, root, { fetcher: async () => new Response('evil', { headers: { 'content-length': '4' } }) }), { code: 'DOWNLOAD_HASH' });
  assert.deepEqual(await fs.readdir(root), []);
});

test('only verified downloads are reused; corrupt cached bytes are replaced', async context => {
  const root = await temporary(context); const pin = record(Buffer.from('synthetic download bytes')); let calls = 0;
  const fetcher = async () => { calls += 1; return new Response('synthetic download bytes'); };
  const filename = await downloadVerified(pin, root, { fetcher });
  await downloadVerified(pin, root, { fetcher }); assert.equal(calls, 1);
  await fs.writeFile(filename, 'corrupt cache');
  await downloadVerified(pin, root, { fetcher }); assert.equal(calls, 2);
});

test('redirects cannot escape publisher allowlist; oversize downloads fail', async context => {
  const root = await temporary(context); const pin = record(Buffer.from('x'));
  await assert.rejects(downloadVerified(pin, root, { fetcher: async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/payload' } }) }), { code: 'DOWNLOAD_HOST' });
  await assert.rejects(downloadVerified(pin, root, { fetcher: async () => new Response('too long') }), { code: 'DOWNLOAD_SIZE' });
  assert.deepEqual(await fs.readdir(root), []);
});

test('real subprocess preserves literal arguments and rejects nonzero/missing executables', async context => {
  const root = await temporary(context); const literal = '中文 路径 ; $(not-a-command)';
  const result = await runProcess(process.execPath, ['-e', 'console.log(process.argv[1])', literal], { cwd: root });
  assert.equal(result.stdout.trim(), literal);
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stderr.write("intentional fixture failure");process.exit(7)'], { cwd: root }), { code: 'PROCESS_EXIT' });
  await assert.rejects(runProcess(path.join(root, 'missing-executable'), [], { cwd: root }), { code: 'PROCESS_START' });
  await assert.rejects(async () => runProcess('relative-command', [], { cwd: root }), { code: 'PROCESS_ARGS' });
  assert.equal(childEnvironment(root).OMP_NUM_THREADS, '2');
});

test('cancellation stops an actual subprocess and its descendant', async context => {
  const root = await temporary(context); const controller = new AbortController(); let descendant;
  let started; const ready = new Promise(resolve => { started = resolve; });
  const script = 'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); console.log(child.pid);process.on("SIGTERM",()=>{child.kill();child.on("close",()=>process.exit(0));});setInterval(()=>{},1000)';
  const running = runProcess(process.execPath, ['-e', script], { cwd: root, signal: controller.signal, onLog: line => { if (/^\d+/.test(line)) { descendant = Number(line.trim()); started(); } } });
  const rejected = assert.rejects(running, { code: 'CANCELLED' });
  await ready; controller.abort(); await rejected;
  await new Promise(resolve => setTimeout(resolve, 100));
  let alive = false;
  try { process.kill(descendant, 0); alive = true; } catch (error) { assert.equal(error.code, 'ESRCH'); }
  if (alive && process.platform === 'linux') alive = !(await fs.readFile(`/proc/${descendant}/status`, 'utf8')).includes('State:\tZ');
  assert.equal(alive, false, 'descendant must not remain running');
});

test('single job concurrency and cancellation cleanup work with no simulated game build', async context => {
  const root = await temporary(context); const engine = new JobEngine({ cache: path.join(root, 'cache'), manifest: manifest(), platform: 'win32', arch: 'x64' });
  engine.start('preflight', { target: 'ios18', input: null, output: null });
  assert.throws(() => engine.start('prepare', {}), { code: 'BUSY' });
  await engine.cancel();
  assert.equal(engine.snapshot().status, 'cancelled');
  assert.equal(engine.busy, false);
  assert.deepEqual(await fs.readdir(path.join(root, 'cache/jobs')), []);
  engine.start('environment', { target: 'ios18', consent: false });
  await engine.wait(); assert.equal(engine.snapshot().code, 'CONSENT');
});
