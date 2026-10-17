'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { createReadStream } = require('node:fs');
const { assert } = require('./errors');
const { scanTree, sha256, regularFile } = require('./paths');

async function inspectBuildManifest(filename, resourceSizes, signal) {
  assert((await fs.stat(filename)).size <= 256 * 1024 ** 2, 'GAME_MANIFEST', 'Resource manifest exceeds the 256 MiB limit.');
  const stream = createReadStream(filename, { encoding: 'utf8', signal });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let records = 0;
  let header = false;
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      assert(line.length < 65536, 'GAME_MANIFEST', 'Resource manifest line is too long.');
      if (!line.trim() || line.startsWith('#')) continue;
      if (!header) {
        assert(line.replace(/^\uFEFF/, '').startsWith('FileId|KeyLayout|Chunk|Archive|CKey|CSize|EKey|ESize|Encoding|Path|Flags'), 'GAME_MANIFEST', 'Unrecognized build_manifest.psv header.');
        header = true;
        continue;
      }
      const fields = line.split('|');
      assert(fields.length >= 11 && /^\d+$/.test(fields[2]) && /^\d+$/.test(fields[3]) && /^[a-f0-9]{32}$/i.test(fields[4]) && /^[a-f0-9]{32}$/i.test(fields[6]) && /^\d+$/.test(fields[5]) && /^\d+$/.test(fields[7]) && fields[9].length > 0, 'GAME_MANIFEST', 'Malformed resource manifest record.');
      const resource = `${fields[2].padStart(2, '0')}-${fields[3].padStart(8, '0')}.data`;
      const size = resourceSizes.get(resource);
      const offset = parseInt(fields[6].slice(-10), 16);
      assert(size !== undefined && Number.isSafeInteger(Number(fields[7])) && offset + Number(fields[7]) <= size, 'GAME_RESOURCE', `Manifest references missing/truncated archive: ${resource}`);
      records += 1;
      assert(records <= 2000000, 'GAME_MANIFEST', 'Resource manifest has too many records.');
    }
  } finally { lines.close(); stream.destroy(); }
  assert(header && records > 0, 'GAME_MANIFEST', 'Resource manifest has no data records.');
  return records;
}

async function validateGame(root, target, { signal, onFile = () => {} } = {}) {
  const tree = await scanTree(root, { signal });
  const names = new Set(tree.entries.filter(entry => !entry.directory).map(entry => entry.path.split(path.sep).join('/')));
  assert(['main', 'sdk', 'subsdk0'].every(name => names.has(`ExeFS/${name}`)) && names.has('RomFS/data/build_manifest.psv'), 'GAME_MISSING', 'Select the folder containing ExeFS/{main,sdk,subsdk0} and RomFS/data/build_manifest.psv. NSP/XCI/IPA are not inputs.');
  assert(!tree.entries.some(entry => /(^|[\\/])(save|saves|savedgames|saved games)([\\/]|$)/i.test(entry.path)), 'SAVES_PRESENT', 'Keep saves outside the input folder; saves are never processed.');
  assert(target, 'GAME_VERSION_UNVERIFIED', 'No reviewed game version contract is available.');
  for (const [index, file] of target.game.programs.entries()) {
    const filename = await regularFile(path.join(tree.root, file.path));
    assert(await sha256(filename, signal) === file.sha256, 'GAME_VERSION', `Wrong version or corrupted program: ${file.path}. Expected Switch ${target.game.version} / ${target.game.internalVersion} + expansion.`);
    onFile({ completed: index + 1, total: 3, name: file.path });
  }
  const resourceSizes = new Map();
  for (const entry of tree.entries.filter(entry => !entry.directory && /^RomFS[\\/]data[\\/]\d{2}-\d{8}\.data$/.test(entry.path))) resourceSizes.set(path.basename(entry.path), entry.bytes);
  for (const name of target.game.resources) assert(resourceSizes.get(name) > 0, 'GAME_RESOURCE', `Required resource missing or empty: RomFS/data/${name}`);
  const records = await inspectBuildManifest(path.join(tree.root, 'RomFS/data/build_manifest.psv'), resourceSizes, signal);
  const wanted = new Set([...target.game.programs.map(file => file.path), 'RomFS/data/build_manifest.psv', ...[...resourceSizes.keys()].map(name => `RomFS/data/${name}`)]);
  const directories = new Set(['ExeFS', 'RomFS', 'RomFS/data']);
  const entries = tree.entries.filter(entry => (entry.directory ? directories : wanted).has(entry.path.split(path.sep).join('/')));
  return { ...tree, entries, bytes: entries.filter(entry => !entry.directory).reduce((total, entry) => total + entry.bytes, 0), verification: { programHashesVerified: 3, requiredResourcesPresent: 18, manifestRecordsChecked: records, resourceCryptographicVerification: false, note: 'Upstream publishes no complete archive hashes; resource presence and manifest extents checked, not full resource authenticity. Upstream validates derived content during generation.' } };
}

module.exports = { validateGame, inspectBuildManifest };
