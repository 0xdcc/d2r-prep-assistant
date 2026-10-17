'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { temporary, manifest } = require('./helpers');
const { validateGame, inspectBuildManifest } = require('../src/engine/game');
const { validateLocations, scanTree, publishFile, copyPrivate, inside } = require('../src/engine/paths');
const { redact, JobLog } = require('../src/engine/log');
const { copyExclusive, cleanupWorkspace } = require('../src/engine/paths');
const { exportNewLog } = require('../src/engine/log');
const crypto = require('node:crypto');

test('link-unsupported publication uses exclusive streams, including an existing-path race', async context => {
  const root = await temporary(context); const output = path.join(root, 'output'); await fs.mkdir(output);
  const staged = path.join(root, 'staged'); await fs.writeFile(staged, 'synthetic publication protocol');
  const linkMock = context.mock.method(fs, 'link', async () => { throw Object.assign(new Error('synthetic exFAT capability'), { code: 'ENOTSUP' }); });
  const published = await publishFile(staged, output, 'new.ipa');
  assert.equal(await fs.readFile(published, 'utf8'), 'synthetic publication protocol');
  await assert.rejects(publishFile(staged, output, 'new.ipa'), { code: 'EEXIST' });
  linkMock.mock.mockImplementation(async (_partial, destination) => {
    await fs.writeFile(destination, 'racing original', { flag: 'wx' });
    throw Object.assign(new Error('unsupported link'), { code: 'EPERM' });
  });
  await assert.rejects(publishFile(staged, output, 'race.ipa'), { code: 'EEXIST', recoveryPath: staged });
  assert.equal(await fs.readFile(path.join(output, 'race.ipa'), 'utf8'), 'racing original');
  assert.equal(await fs.readFile(staged, 'utf8'), 'synthetic publication protocol');
  assert.deepEqual((await fs.readdir(output)).sort(), ['new.ipa', 'race.ipa']);
});

test('failed fallback retains the staged result through job cleanup', async context => {
  const root = await temporary(context); const output = path.join(root, 'output'); const workspace = path.join(root, 'job');
  await fs.mkdir(output); await fs.mkdir(workspace); await fs.mkdir(path.join(workspace, 'private-game-copy'));
  const staged = path.join(workspace, 'prepared.ipa'); await fs.writeFile(staged, 'synthetic verified-result protocol');
  context.mock.method(fs, 'link', async () => { throw Object.assign(new Error('unsupported'), { code: 'EXDEV' }); });
  const originalOpen = fs.open;
  context.mock.method(fs, 'open', async (filename, ...args) => {
    if (filename === path.join(output, 'failed.ipa')) throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
    return originalOpen(filename, ...args);
  });
  let failure;
  try { await publishFile(staged, output, 'failed.ipa'); } catch (error) { failure = error; }
  assert.equal(failure.code, 'ENOSPC'); assert.equal(failure.recoveryPath, staged);
  await cleanupWorkspace(workspace, failure.recoveryPath);
  assert.deepEqual(await fs.readdir(workspace), ['prepared.ipa']);
  assert.equal(await fs.readFile(staged, 'utf8'), 'synthetic verified-result protocol');
  assert.deepEqual(await fs.readdir(output), []);
});

test('mid-stream copy cancellation removes private partials and leaves source unchanged', async context => {
  const root = await temporary(context); const input = path.join(root, 'input'); await fs.mkdir(input);
  const source = path.join(input, 'large-synthetic-protocol'); const handle = await fs.open(source, 'wx');
  await handle.truncate(64 * 1024 * 1024); await handle.close();
  const destination = path.join(root, 'copy'); const target = path.join(destination, 'large-synthetic-protocol');
  const controller = new AbortController(); const originalOpen = fs.open; let copiedBytes = 0;
  context.mock.method(fs, 'open', async (...args) => {
    const opened = await originalOpen(...args);
    if (args[0] === target) {
      const create = opened.createWriteStream.bind(opened);
      opened.createWriteStream = (...options) => {
        const stream = create(...options); const write = stream._write.bind(stream);
        stream._write = (chunk, encoding, callback) => {
          write(chunk, encoding, error => { copiedBytes += chunk.length; controller.abort(); callback(error); });
        };
        return stream;
      };
    }
    return opened;
  });
  const tree = await scanTree(input);
  await assert.rejects(copyPrivate(tree, destination, controller.signal), { name: 'AbortError' });
  assert(copiedBytes > 0 && copiedBytes < tree.bytes);
  assert.equal(await fs.stat(destination).catch(() => null), null);
  assert.equal((await fs.stat(source)).size, tree.bytes);
  assert.deepEqual(await fs.readFile(source), Buffer.alloc(tree.bytes));
});

test('exclusive stream copy never follows or removes an existing destination', async context => {
  const root = await temporary(context); const source = path.join(root, 'source'); const target = path.join(root, 'target');
  await fs.writeFile(source, 'synthetic source'); await fs.writeFile(target, 'original');
  await assert.rejects(copyExclusive(source, target), { code: 'EEXIST' });
  assert.equal(await fs.readFile(target, 'utf8'), 'original');
});

test('log export creates unique files and refuses collision, links and linked folders', async context => {
  const root = await temporary(context); const exported = await exportNewLog(root, 'redacted synthetic log');
  assert.equal(await fs.readFile(exported, 'utf8'), 'redacted synthetic log');
  const identifier = path.basename(exported).slice('d2r-prep-'.length, -4);
  context.mock.method(crypto, 'randomUUID', () => identifier);
  await assert.rejects(exportNewLog(root, 'replacement'), { code: 'EEXIST' });
  assert.equal(await fs.readFile(exported, 'utf8'), 'redacted synthetic log');
  if (process.platform === 'win32') return;
  const original = path.join(root, 'original'); await fs.writeFile(original, 'do not touch');
  await fs.rm(exported); await fs.symlink(original, exported);
  await assert.rejects(exportNewLog(root, 'replacement'), { code: 'EEXIST' });
  assert.equal(await fs.readFile(original, 'utf8'), 'do not touch');
  const alias = path.join(root, 'alias'); await fs.symlink(root, alias);
  await assert.rejects(exportNewLog(alias, 'replacement'), { code: 'UNSAFE_LINK' });
});

test('missing programs and wrong real program hashes fail, without main.npdm requirement', async context => {
  const root = await temporary(context);
  await assert.rejects(validateGame(root, manifest().targets[0]), { code: 'GAME_MISSING' });
  await fs.mkdir(path.join(root, 'ExeFS'));
  await fs.mkdir(path.join(root, 'RomFS/data'), { recursive: true });
  for (const name of ['main', 'sdk', 'subsdk0']) await fs.writeFile(path.join(root, 'ExeFS', name), 'synthetic rejection fixture, not game data');
  await fs.writeFile(path.join(root, 'RomFS/data/build_manifest.psv'), 'invalid');
  await assert.rejects(validateGame(root, manifest().targets[0]), { code: 'GAME_VERSION' });
});

test('PSV parser checks actual manifest shape and archive extents, not invented hashes', async context => {
  const root = await temporary(context);
  const filename = path.join(root, 'synthetic-manifest.psv');
  const header = 'FileId|KeyLayout|Chunk|Archive|CKey|CSize|EKey|ESize|Encoding|Path|Flags\n';
  const row = `1|0|0|1|${'a'.repeat(32)}|4|${'0'.repeat(32)}|4|n|data:synthetic-protocol-only|0\n`;
  await fs.writeFile(filename, header + row);
  assert.equal(await inspectBuildManifest(filename, new Map([['00-00000001.data', 4]])), 1);
  await assert.rejects(inspectBuildManifest(filename, new Map([['00-00000001.data', 3]])), { code: 'GAME_RESOURCE' });
  await fs.writeFile(filename, header + 'broken|record\n');
  await assert.rejects(inspectBuildManifest(filename, new Map()), { code: 'GAME_MANIFEST' });
  await fs.writeFile(filename, header);
  await assert.rejects(inspectBuildManifest(filename, new Map()), { code: 'GAME_MANIFEST' });
});

test('Chinese/spaced paths work; nested source/output/cache and links are refused', async context => {
  const root = await temporary(context);
  const input = path.join(root, '自有 文件'); const output = path.join(root, '输出 IPA'); const cache = path.join(root, '应用 缓存');
  for (const folder of [input, output, cache]) await fs.mkdir(folder);
  assert.equal((await validateLocations({ input, output, cache })).input, input);
  const nested = path.join(input, 'nested'); await fs.mkdir(nested);
  await assert.rejects(validateLocations({ input, output: nested, cache }), { code: 'PATH_OVERLAP' });
  await fs.writeFile(path.join(input, 'literal ; $ file.txt'), 'synthetic path fixture');
  const tree = await scanTree(input);
  const copy = path.join(root, 'private'); await copyPrivate(tree, copy);
  assert.equal(await fs.readFile(path.join(copy, 'literal ; $ file.txt'), 'utf8'), 'synthetic path fixture');
  assert.equal(inside(input, `${input}-not-inside`), false);
  await fs.link(path.join(input, 'literal ; $ file.txt'), path.join(input, 'hardlink'));
  await assert.rejects(scanTree(input), { code: 'UNSAFE_FILE' });
});

test('symlinks cannot enter input trees or selected output directories', { skip: process.platform === 'win32' }, async context => {
  const root = await temporary(context); await fs.mkdir(path.join(root, 'input')); await fs.symlink('/etc/passwd', path.join(root, 'input/link'));
  await assert.rejects(scanTree(path.join(root, 'input')), { code: 'UNSAFE_LINK' });
});

test('existing output is kept and failed publication leaves no partial file', async context => {
  const root = await temporary(context); const output = path.join(root, 'output'); await fs.mkdir(output);
  const staged = path.join(root, 'synthetic-staging.zip'); await fs.writeFile(staged, 'synthetic publication protocol only');
  await fs.writeFile(path.join(output, 'existing.ipa'), 'original stays');
  await assert.rejects(publishFile(staged, output, 'existing.ipa'), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(output, 'existing.ipa'), 'utf8'), 'original stays');
  assert.deepEqual(await fs.readdir(output), ['existing.ipa']);
  await assert.rejects(publishFile(staged, output, '../escape.ipa'), { code: 'OUTPUT_NAME' });
});

test('redacted logs are disk/ring bounded and hide paths, secrets and URLs', async context => {
  const root = await temporary(context); const filename = path.join(root, 'job.log'); const log = new JobLog(filename, [root]);
  for (let index = 0; index < 280; index += 1) log.append(`${root} secret=abcd https://example.test/token`);
  assert.equal(log.lines.length, 250);
  const content = await fs.readFile(filename, 'utf8');
  assert(!content.includes(root)); assert(!content.includes('abcd')); assert(!content.includes('https://'));
  assert.equal(redact('password=123'), 'password=[REDACTED]');
});
