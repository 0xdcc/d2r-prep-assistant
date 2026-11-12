'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { runProcess } = require('./process');
const { regularFile, directory, sha256 } = require('./paths');
const { assert } = require('./errors');

const HELPER = path.join(__dirname, 'archive.py');

async function extractArchive(python, filename, destination, options = {}) {
  await regularFile(filename);
  await fs.mkdir(destination, { recursive: false });
  const result = await runProcess(python, ['-I', '-B', HELPER, 'extract', filename, destination, String(options.maxBytes || 8 * 1024 ** 3)], options);
  return JSON.parse(result.stdout);
}

async function verifyIpa(python, filename, target, options = {}) {
  await regularFile(filename);
  const spec = path.join(options.cwd, `${crypto.randomUUID()}-verification.json`);
  await fs.writeFile(
    spec,
    JSON.stringify({
      shellInfo: target.shellInfo,
      shellManifest: target.shellManifest,
      minimumOS: target.minimumOS,
      legacy: Boolean(options.legacy)
    }),
    { flag: 'wx', mode: 0o600 }
  );
  try {
    const result = await runProcess(python, ['-I', '-B', HELPER, options.shellOnly ? 'verify-shell' : 'verify', filename, spec], options);
    return JSON.parse(result.stdout);
  } finally {
    await fs.rm(spec, { force: true });
  }
}

async function verifyAndroidPack(androidDir) {
  const dir = await directory(androidDir);
  const packInfoPath = path.join(dir, 'pack_info.txt');
  await regularFile(packInfoPath);
  const packInfo = await fs.readFile(packInfoPath, 'utf8');
  assert(packInfo.includes('PRODUCT=3.3.94012-r45'), 'VERIFY_ANDROID', 'pack_info.txt missing PRODUCT=3.3.94012-r45.');
  assert(packInfo.includes('TARGET=android'), 'VERIFY_ANDROID', 'pack_info.txt missing TARGET=android.');

  const derivedPath = path.join(dir, 'derived.tsv');
  await regularFile(derivedPath);
  assert((await fs.stat(derivedPath)).size > 0, 'VERIFY_ANDROID', 'derived.tsv is empty.');

  const outDir = path.join(dir, 'out');
  await directory(outDir);
  const outFiles = await fs.readdir(outDir);
  for (const prog of ['main.patched.bin', 'sdk.patched.bin', 'subsdk0.patched.bin']) {
    assert(outFiles.includes(prog), 'VERIFY_ANDROID', `Missing patched binary: out/${prog}`);
    assert((await fs.stat(path.join(outDir, prog))).size > 0, 'VERIFY_ANDROID', `Empty patched binary: out/${prog}`);
  }
  assert(outFiles.some(f => f.endsWith('.gates.tsv')), 'VERIFY_ANDROID', 'out/ missing *.gates.tsv.');

  const shadersDir = path.join(dir, 'shaders');
  await directory(shadersDir);
  const shaderFiles = await fs.readdir(shadersDir);
  const xgsFiles = shaderFiles.filter(f => f.endsWith('.xgs'));
  assert(xgsFiles.length >= 100, 'VERIFY_ANDROID', `shaders/ contains only ${xgsFiles.length} .xgs files (expected >= 100).`);
  assert(xgsFiles.some(f => f.startsWith('query_')), 'VERIFY_ANDROID', 'shaders/ missing builtin query .xgs files.');

  const overlayDir = path.join(dir, 'overlay');
  await directory(overlayDir);
  assert((await fs.readdir(overlayDir)).length > 0, 'VERIFY_ANDROID', 'overlay/ is empty.');

  const variantsDir = path.join(dir, 'overlay_variants');
  await directory(variantsDir);
  assert((await fs.readdir(variantsDir)).length > 0, 'VERIFY_ANDROID', 'overlay_variants/ is empty.');

  return {
    verified: true,
    packInfoVerified: true,
    shadersCount: xgsFiles.length,
    programsVerified: true,
    overlayVerified: true
  };
}

async function verifyLegacyPack(packDir) {
  const dir = await directory(packDir);
  const packJsonFile = path.join(dir, 'pack.json');
  await regularFile(packJsonFile);
  const packJson = JSON.parse(await fs.readFile(packJsonFile, 'utf8'));
  assert(packJson.name && Number.isSafeInteger(packJson.size) && packJson.size > 0 && /^[a-f0-9]{64}$/.test(packJson.sha256), 'VERIFY_LEGACY', 'Invalid pack.json.');

  const packIndexFile = path.join(dir, 'pack_index.tsv');
  await regularFile(packIndexFile);
  const indexFirstLine = (await fs.readFile(packIndexFile, 'utf8')).split('\n')[0];
  assert(indexFirstLine.startsWith('# pack'), 'VERIFY_LEGACY', 'pack_index.tsv header invalid.');

  const legacyFolder = path.join(dir, 'Legacy Device Pack');
  await directory(legacyFolder);
  const manifestFile = path.join(legacyFolder, 'manifest.json');
  await regularFile(manifestFile);
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  assert(Array.isArray(manifest.files) && manifest.files.length > 0, 'VERIFY_LEGACY', 'Legacy manifest.json missing files.');

  const dataFile = path.join(legacyFolder, 'data', packJson.name);
  await regularFile(dataFile);
  const dataStat = await fs.stat(dataFile);
  assert(dataStat.size === packJson.size, 'VERIFY_LEGACY', `Data file size ${dataStat.size} differs from declared ${packJson.size}.`);
  const dataSha = await sha256(dataFile);
  assert(dataSha === packJson.sha256, 'VERIFY_LEGACY', 'Data file sha256 mismatch.');

  return {
    verified: true,
    packJsonVerified: true,
    dataVerified: true,
    sha256: packJson.sha256,
    size: packJson.size,
    name: packJson.name
  };
}

module.exports = { extractArchive, verifyIpa, verifyAndroidPack, verifyLegacyPack };
