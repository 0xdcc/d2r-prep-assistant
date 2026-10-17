'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { temporary, python, zipFixture, manifest } = require('./helpers');
const { extractArchive, verifyIpa } = require('../src/engine/archive');
const { extractTarGzip } = require('../src/engine/tar');
const { runProcess } = require('../src/engine/process');
const { sha256 } = require('../src/engine/paths');

test('ZIP members beyond 300 characters extract without Windows registry long-path policy', async context => {
  const root = await temporary(context); const interpreter = await python();
  const name = ['nested-'.repeat(10), '中文 路径-'.repeat(8), 'long-segment-'.repeat(8), 'libwindows.networking.networkoperators.hotspotauthentication.a'].join('/');
  const destination = path.join(root, 'private staging');
  assert(path.join(destination, name).length > 300);
  const archive = await zipFixture(root, [{ name, data: 'synthetic long-path regression' }]);
  await extractArchive(interpreter, archive, destination, { cwd: root });
  assert.equal(await fs.readFile(path.join(destination, name), 'utf8'), 'synthetic long-path regression');
});

test('Windows extended paths preserve UNC and existing extended prefixes', async context => {
  const root = await temporary(context); const interpreter = await python();
  const script = String.raw`
import importlib.util, ntpath, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("archive_helper", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
with patch.object(helper.os, "name", "nt"), patch.object(helper.os, "path", ntpath):
    assert helper.filesystem_path(r"C:\private\nested") == r"\\?\C:\private\nested"
    assert helper.filesystem_path(r"\\server\share\nested") == r"\\?\UNC\server\share\nested"
    assert helper.filesystem_path(r"\\?\UNC\server\share\nested") == r"\\?\UNC\server\share\nested"
    assert helper.filesystem_path(r"\\?\C:\private\nested") == r"\\?\C:\private\nested"
`;
  await runProcess(interpreter, ['-I', '-c', script, path.resolve(__dirname, '../src/engine/archive.py')], { cwd: root });
});

test('ZIP directory mode works without slash; ambiguous regular/directory entries fail', async context => {
  const root = await temporary(context); const interpreter = await python();
  const archive = await zipFixture(root, [{ name: 'directory', mode: 0o40755, data: '' }, { name: 'directory/file', data: 'synthetic' }]);
  const destination = path.join(root, 'extracted');
  await extractArchive(interpreter, archive, destination, { cwd: root });
  assert.equal(await fs.readFile(path.join(destination, 'directory/file'), 'utf8'), 'synthetic');
  for (const [index, entry] of [{ name: 'ambiguous/', mode: 0o100600, data: '' }, { name: 'ambiguous', mode: 0o40755, data: 'file bytes' }].entries()) {
    const invalid = await zipFixture(root, [entry], `ambiguous-${index}.zip`);
    await assert.rejects(extractArchive(interpreter, invalid, path.join(root, `invalid-${index}`), { cwd: root }));
  }
});

test('PAX global harmless metadata is accepted; path, link, size and sparse overrides fail', async context => {
  const root = await temporary(context); const interpreter = await python();
  const script = 'import tarfile,io,json,sys; headers=json.loads(sys.argv[2]); archive=tarfile.open(sys.argv[1],"w:gz",format=tarfile.PAX_FORMAT,pax_headers=headers); member=tarfile.TarInfo("safe.txt"); member.size=9; archive.addfile(member,io.BytesIO(b"synthetic")); archive.close()';
  const attributes = [{ comment: 'synthetic protocol', mtime: '1.5' }, { path: '../escape' }, { linkpath: '../escape' }, { size: '99999999' }, { 'GNU.sparse.size': '99999999' }, { 'SCHILY.realsize': '99999999' }];
  for (const [index, headers] of attributes.entries()) {
    const archive = path.join(root, `pax-${index}.tar.gz`); const destination = path.join(root, `pax-${index}`);
    await runProcess(interpreter, ['-I', '-c', script, archive, JSON.stringify(headers)], { cwd: root });
    if (index === 0) {
      await extractTarGzip(archive, destination);
      assert.equal(await fs.readFile(path.join(destination, 'safe.txt'), 'utf8'), 'synthetic');
    } else await assert.rejects(extractTarGzip(archive, destination), { code: 'ARCHIVE_FORMAT' });
  }
  assert.equal(await fs.stat(path.join(root, 'escape')).catch(() => null), null);
});

test('archive traversal, links, duplicate/case collisions and inflation budget are rejected', async context => {
  const root = await temporary(context); const interpreter = await python();
  const cases = [
    [{ name: '../escape' }], [{ name: '/absolute' }], [{ name: 'C:/escape' }], [{ name: 'dir\\escape' }],
    [{ name: 'link', mode: 0o120777, data: '/etc/passwd' }],
    [{ name: 'same' }, { name: 'SAME' }], [{ name: 'con.txt' }], [{ name: 'large', data: 'x'.repeat(32) }]
  ];
  for (const [index, entries] of cases.entries()) {
    const archive = await zipFixture(root, entries, `unsafe-${index}.zip`);
    await assert.rejects(extractArchive(interpreter, archive, path.join(root, `extract-${index}`), { cwd: root, maxBytes: 16 }));
  }
  assert.equal(await fs.stat(path.join(root, 'escape')).then(() => true, () => false), false);
});

test('tar bootstrap blocks traversal and links by default; approved internal links become copies', async context => {
  const root = await temporary(context); const interpreter = await python();
  const makeTar = async (name, link, archiveName) => {
    const filename = path.join(root, archiveName);
    const script = 'import tarfile,io,sys; t=tarfile.open(sys.argv[1],"w:gz"); d=b"synthetic protocol only"; m=tarfile.TarInfo(sys.argv[2]); m.size=len(d); t.addfile(m,io.BytesIO(d)); link=sys.argv[3]; m=tarfile.TarInfo("alias"); m.type=tarfile.SYMTYPE; m.linkname=link; t.addfile(m);t.close()';
    await runProcess(interpreter, ['-I', '-c', script, filename, name, link], { cwd: root });
    return filename;
  };
  const unsafe = await makeTar('../escape', 'file', 'unsafe.tar.gz');
  await assert.rejects(extractTarGzip(unsafe, path.join(root, 'unsafe')));
  const safe = await makeTar('file', 'file', 'internal.tar.gz');
  await assert.rejects(extractTarGzip(safe, path.join(root, 'reject-links')), { code: 'ARCHIVE_LINK' });
  const destination = path.join(root, 'materialized');
  const result = await extractTarGzip(safe, destination, { materializeLinks: true });
  assert.equal(result.linksMaterialized, 1);
  assert.equal((await fs.lstat(path.join(destination, 'alias'))).isSymbolicLink(), false);
  assert.equal(await fs.readFile(path.join(destination, 'alias'), 'utf8'), 'synthetic protocol only');
  const badLink = await makeTar('file', '../escape', 'badlink.tar.gz');
  await assert.rejects(extractTarGzip(badLink, path.join(root, 'badlink'), { materializeLinks: true }));
});

test('output verifier rejects missing, corrupt and clean-shell-only artifacts', async context => {
  const root = await temporary(context); const interpreter = await python(); const target = manifest().targets[0];
  await assert.rejects(verifyIpa(interpreter, path.join(root, 'missing.zip'), target, { cwd: root }));
  const invalid = path.join(root, 'corrupt.zip'); await fs.writeFile(invalid, 'not a ZIP');
  await assert.rejects(verifyIpa(interpreter, invalid, target, { cwd: root }));
  const empty = await zipFixture(root, [{ name: 'Payload/DmIOS.app/Info.plist', data: 'invalid plist' }]);
  await assert.rejects(verifyIpa(interpreter, empty, target, { cwd: root }));
});

test('synthetic output-verifier protocol requires actual INI PRODUCT and every shell member, not JSON', async context => {
  const root = await temporary(context); const interpreter = await python(); const target = manifest().targets[0];
  const base = 'Payload/DmIOS.app/';
  const plist = '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>DmIOS</string><key>CFBundleIdentifier</key><string>org.d2rmobile.app</string><key>MinimumOSVersion</key><string>18.0</string></dict></plist>';
  const entries = [
    { name: base + 'Info.plist', data: plist },
    { name: base + 'DmIOS', base64: Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(60)]).toString('base64') },
    { name: base + 'dm/shell_info.txt', data: Object.entries(target.shellInfo).map(([key, value]) => `${key}=${value}`).join('\n') },
    { name: base + 'dm/shell_manifest.txt', data: target.shellManifest.join('\n') },
    { name: base + 'dm/pack_info.txt', data: `PRODUCT=${target.shellInfo.PRODUCT}\n` },
    ...target.shellManifest.map(name => ({ name: base + name + (name.endsWith('/') ? 'synthetic-protocol-only.txt' : ''), data: 'synthetic verifier protocol, NOT a game artifact' })),
    { name: base + 'Frameworks/Guest.framework/Guest', base64: Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]).toString('base64') }
  ];
  const archive = await zipFixture(root, entries, 'synthetic-verifier-protocol.zip');
  const result = await verifyIpa(interpreter, archive, target, { cwd: root });
  assert.equal(result.packProductVerified, true);
  entries.find(entry => entry.name.endsWith('dm/pack_info.txt')).data = 'PRODUCT=wrong\n';
  const mismatch = await zipFixture(root, entries, 'synthetic-wrong-product.zip');
  await assert.rejects(verifyIpa(interpreter, mismatch, target, { cwd: root }));
  const missing = await zipFixture(root, entries.filter(entry => !entry.name.endsWith('dm/pack_info.txt')), 'synthetic-missing-product.zip');
  await assert.rejects(verifyIpa(interpreter, missing, target, { cwd: root }));
});

test('real pinned clean shells match metadata but cannot pass completed-output verification', async context => {
  const root = await temporary(context); const interpreter = await python();
  for (const target of manifest().targets) {
    const archive = path.resolve(__dirname, `../evidence/upstream/${target.id}.zip`);
    if (!await fs.stat(archive).catch(() => null)) { context.skip('Optional parent-owned upstream archives unavailable.'); return; }
    assert.equal(await sha256(archive), target.shell.sha256);
    const result = await verifyIpa(interpreter, archive, target, { cwd: root, shellOnly: true });
    assert.equal(result.shellMetadataVerified, true);
    await assert.rejects(verifyIpa(interpreter, archive, target, { cwd: root }));
  }
});

test('real pinned immutable source safely extracts and PRODUCT matches shell', async context => {
  const root = await temporary(context); const target = manifest().targets[0];
  const archive = path.resolve(__dirname, '../evidence/upstream/source-commit.zip');
  if (!await fs.stat(archive).catch(() => null)) { context.skip('Optional parent-owned source archive unavailable.'); return; }
  assert.equal(await sha256(archive), target.source.sha256);
  await extractArchive(await python(), archive, path.join(root, 'source'), { cwd: root });
  assert.equal((await fs.readFile(path.join(root, 'source', target.sourceRoot, 'dm/PRODUCT'), 'utf8')).trim(), target.shellInfo.PRODUCT);
});

test('real Windows portable Python bootstraps with Node alone into Chinese/spaced paths', async context => {
  const root = await temporary(context); const archive = path.resolve(__dirname, '../.cache/portable-artifacts/python-win-x64.tar.gz');
  if (!await fs.stat(archive).catch(() => null)) { context.skip('Optional parent-owned portable archive unavailable.'); return; }
  const target = manifest().portableTools.find(tool => tool.id === 'python' && tool.host === 'win32-x64');
  assert.equal(await sha256(archive), target.sha256);
  const destination = path.join(root, '便携 Python');
  await extractTarGzip(archive, destination);
  assert((await fs.stat(path.join(destination, target.executable))).size > 0);
});

test('real approved Mac Python and .NET tar archives remain extractable', async context => {
  const root = await temporary(context);
  for (const [index, filename] of ['python-mac-arm64.tar.gz', 'dotnet-mac-arm64.tar.gz'].entries()) {
    const archive = path.resolve(__dirname, '../.cache/portable-artifacts', filename);
    if (!await fs.stat(archive).catch(() => null)) { context.skip('Optional parent-owned portable archive unavailable.'); return; }
    const tool = manifest().portableTools.find(record => record.id === (index === 0 ? 'python' : 'dotnet') && record.host === 'darwin-arm64');
    if (tool.sha256) assert.equal(await sha256(archive), tool.sha256);
    const destination = path.join(root, `actual-approved-${index}`);
    const result = await extractTarGzip(archive, destination, { maxBytes: 4 * 1024 ** 3, materializeLinks: tool.materializeLinks === true });
    assert(result.files > 0);
    assert((await fs.stat(path.join(destination, tool.executable))).isFile());
  }
});
