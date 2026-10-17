'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validateManifest, targetMatrix, checkedUrl, relativeName } = require('../src/engine/manifest');
const { validateRequest } = require('../src/engine/ipc-schema');
const { manifest } = require('./helpers');
const { packEnvironment, localEnvironment } = require('../src/engine/environment');
const path = require('node:path');

test('real production pins enable both iOS targets on Windows and Mac only', () => {
  const value = manifest();
  for (const host of [['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64']]) {
    const matrix = targetMatrix(...host, value);
    assert.equal(matrix.targets.filter(target => target.enabled).length, 2);
    assert.equal(matrix.nativeMac.enabled, false);
  }
  assert.equal(targetMatrix('linux', 'x64', value).hostSupported, false);
  assert.equal(targetMatrix('win32', 'arm64', value).hostSupported, false);
  assert.equal(value.targets[0].game.programs.length, 3);
  assert.equal(value.targets[0].game.resources.length, 18);
  assert.equal(value.targets[0].outputGameManifest, undefined);
  assert(value.portableTools.every(record => record.bytes > 0 && record.sha256));
});

test('manifest rejects changed repository, branch source and wrong program contract', () => {
  for (const mutate of [value => { value.repository = 'https://github.com/attacker/d2r-mobile'; }, value => { value.targets[0].source.url = 'https://github.com/jhaizhou-ops/d2r-mobile/archive/main.zip'; }, value => { value.targets[0].game.programs[2].path = 'ExeFS/main.npdm'; }]) {
    const value = structuredClone(manifest()); mutate(value);
    assert.throws(() => validateManifest(value), { code: 'MANIFEST' });
  }
});

test('publisher URLs and manifest paths cannot escape allowlists', () => {
  for (const url of ['http://github.com/x', 'https://github.com.evil.test/x', 'https://user:pass@github.com/x', 'https://github.com:444/x', 'file:///tmp/a']) assert.throws(() => checkedUrl(url));
  for (const filename of ['../x', '/x', 'C:/x', 'folder\\x', 'a/./b', 'a//b']) assert.throws(() => relativeName(filename));
});

test('IPC has exact fields, fixed help IDs and native-picker tokens, never renderer commands', () => {
  const payload = { kind: 'prepare', target: 'ios18', inputToken: crypto.randomUUID(), outputToken: null, consent: true };
  assert.equal(validateRequest('startJob', payload), payload);
  for (const invalid of [{ ...payload, command: 'rm -rf /' }, { ...payload, inputToken: '/tmp/path' }, { ...payload, kind: 'exec' }, { ...payload, consent: 'true' }, { ...payload, target: 'nativeMac' }]) assert.throws(() => validateRequest('startJob', invalid));
  assert.throws(() => validateRequest('openHelp', { id: 'https://evil.test' }));
  assert.throws(() => validateRequest('__proto__', {}));
  assert.throws(() => validateRequest('bootstrap', []));
});

test('packer uses managed DM_ROOT, no-Metal and complete tool PATH', () => {
  const workspace = path.resolve('/tmp/工作 空间');
  const inspected = { python: path.resolve('/tmp/venv/bin/python'), tools: { python: path.resolve('/tmp/python/bin/python'), compiler: path.resolve('/tmp/llvm/bin/clang'), dotnet: path.resolve('/tmp/dotnet/dotnet'), spirv: path.resolve('/tmp/spirv/spirv-cross') } };
  const environment = packEnvironment(inspected, workspace);
  assert.equal(environment.DM_ROOT, path.join(workspace, 'dm-root'));
  assert.equal(environment.D2RM_NO_METAL, '1');
  assert.equal(environment.DOTNET_ROOT, path.dirname(inspected.tools.dotnet));
  assert.equal(environment.CC, inspected.tools.compiler);
  assert(environment.PATH.startsWith(path.dirname(inspected.python)));
  assert.equal(localEnvironment(workspace, { compiler: '/usr/bin/gcc' }).CXX, '/usr/bin/g++');
});
