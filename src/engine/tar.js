'use strict';

const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const { createGunzip } = require('node:zlib');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { assert } = require('./errors');
const { inside, noLinks, regularFile, copyExclusive } = require('./paths');

function safeName(name) {
  const normalized = name.replace(/^(\.\/)+/, '').replace(/\/$/, '');
  assert(normalized && !/[\\:\0]/.test(normalized) && !normalized.startsWith('/') && normalized.split('/').every(part => part && part !== '.' && part !== '..' && !/[ .]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)), 'ARCHIVE_PATH', 'Unsafe tar member path.');
  return normalized;
}

function tarNumber(buffer) {
  assert(!(buffer[0] & 0x80), 'ARCHIVE_FORMAT', 'Base-256 tar numbers are unsupported.');
  const text = buffer.toString('ascii').replace(/\0.*$/, '').trim();
  assert(/^[0-7]*$/.test(text), 'ARCHIVE_FORMAT', 'Invalid tar number.');
  return parseInt(text || '0', 8);
}

async function extractTarGzip(filename, destination, { signal, maxBytes = 3 * 1024 ** 3, materializeLinks = false, include = null } = {}) {
  await regularFile(filename);
  await fs.mkdir(destination, { recursive: false, mode: 0o700 });
  await noLinks(destination);
  const temporary = path.join(destination, '.archive-data.tmp');
  let inflated = 0;
  const limiter = new Transform({ transform(chunk, encoding, callback) {
    inflated += chunk.length;
    if (inflated > maxBytes) callback(new Error('Tar inflated byte budget exceeded.'));
    else callback(null, chunk);
  } });
  let handle;
  try {
    await pipeline(createReadStream(filename), createGunzip(), limiter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
    handle = await fs.open(temporary, 'r');
    let offset = 0;
    let files = 0;
    let total = 0;
    let headers = 0;
    let extended = {};
    const seen = new Set(['.archive-data.tmp']);
    const links = [];
    while (offset + 512 <= inflated) {
      signal?.throwIfAborted();
      const header = Buffer.alloc(512);
      assert((await handle.read(header, 0, 512, offset)).bytesRead === 512, 'ARCHIVE_FORMAT', 'Truncated tar header.');
      if (header.every(byte => byte === 0)) break;
      assert(++headers <= 200000, 'ARCHIVE_LIMIT', 'Tar header count limit exceeded.');
      const expected = tarNumber(header.subarray(148, 156));
      const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      assert(expected === actual, 'ARCHIVE_FORMAT', 'Tar header checksum mismatch.');
      const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');
      let name = field(0, 100);
      const prefix = field(345, 155);
      if (prefix) name = `${prefix}/${name}`;
      const size = tarNumber(header.subarray(124, 136));
      const mode = tarNumber(header.subarray(100, 108));
      const type = field(156, 1) || '0';
      offset += 512;
      assert(Number.isSafeInteger(size) && offset + size <= inflated, 'ARCHIVE_FORMAT', 'Truncated tar content.');
      if (type === 'x' || type === 'g') {
        assert(size < 1024 * 1024, 'ARCHIVE_FORMAT', 'Oversized tar metadata.');
        const data = Buffer.alloc(size);
        await handle.read(data, 0, size, offset);
        const attributes = {};
        let position = 0;
        while (position < data.length) {
          const separator = data.indexOf(32, position);
          const length = Number(data.subarray(position, separator).toString());
          assert(separator > position && Number.isSafeInteger(length) && length > separator - position + 2 && position + length <= data.length && data[position + length - 1] === 10, 'ARCHIVE_FORMAT', 'Malformed PAX record.');
          const entry = data.subarray(separator + 1, position + length - 1).toString('utf8');
          const equals = entry.indexOf('=');
          assert(equals > 0, 'ARCHIVE_FORMAT', 'Malformed PAX attribute.');
          const key = entry.slice(0, equals);
          assert(['path', 'linkpath', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'comment', 'charset', 'hdrcharset'].includes(key) && (type !== 'g' || !['path', 'linkpath'].includes(key)), 'ARCHIVE_FORMAT', 'Unsupported PAX structural override.');
          assert(!Object.hasOwn(attributes, key), 'ARCHIVE_FORMAT', 'Duplicate PAX attribute.');
          attributes[key] = entry.slice(equals + 1);
          position += length;
        }
        if (type === 'x') extended = { ...extended, ...attributes };
      } else {
        if (type === '5' && /^\.(\/)?$/.test(name)) { offset += Math.ceil(size / 512) * 512; continue; }
        name = safeName(extended.path || name);
        const linkName = extended.linkpath || field(157, 100);
        extended = {};
        assert(!seen.has(name.toLowerCase()) && ++files <= 100000, 'ARCHIVE_LIMIT', 'Tar duplicate/case collision or file limit.');
        seen.add(name.toLowerCase());
        if (include && !include.some(prefix => name === prefix || name.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))) { offset += Math.ceil(size / 512) * 512; continue; }
        const target = path.join(destination, ...name.split('/'));
        assert(inside(destination, target), 'ARCHIVE_PATH', 'Tar destination escape.');
        assert(['0', '5', '1', '2'].includes(type), 'ARCHIVE_LINK', 'Tar special files are forbidden.');
        if (type === '5') await fs.mkdir(target, { recursive: true, mode: 0o700 });
        else if (type === '1' || type === '2') {
          assert(materializeLinks && size === 0, 'ARCHIVE_LINK', 'Tar links are forbidden for this recipe.');
          const sourceName = safeName(path.posix.normalize(type === '2' ? path.posix.join(path.posix.dirname(name), linkName) : linkName));
          assert(!path.posix.isAbsolute(linkName) && !linkName.includes('\\'), 'ARCHIVE_LINK', 'Unsafe tar link target.');
          links.push({ target, source: path.join(destination, ...sourceName.split('/')) });
        } else {
          total += size;
          assert(total <= maxBytes, 'ARCHIVE_LIMIT', 'Tar extracted byte budget exceeded.');
          await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await noLinks(path.dirname(target));
          const output = await fs.open(target, 'wx', mode & 0o111 ? 0o700 : 0o600);
          try {
            let copied = 0;
            const buffer = Buffer.alloc(Math.min(size || 1, 1024 * 1024));
            while (copied < size) {
              signal?.throwIfAborted();
              const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - copied), offset + copied);
              assert(bytesRead > 0, 'ARCHIVE_FORMAT', 'Truncated tar member.');
              await output.writeFile(buffer.subarray(0, bytesRead));
              copied += bytesRead;
            }
          } finally { await output.close(); }
        }
      }
      offset += Math.ceil(size / 512) * 512;
    }
    assert(files > 0, 'ARCHIVE_FORMAT', 'Empty tar archive.');
    for (const link of links) {
      signal?.throwIfAborted();
      assert(inside(destination, link.source), 'ARCHIVE_LINK', 'Link target escapes archive.');
      await regularFile(link.source);
      await fs.mkdir(path.dirname(link.target), { recursive: true, mode: 0o700 });
      await noLinks(path.dirname(link.target));
      total += (await fs.stat(link.source)).size;
      assert(total <= maxBytes, 'ARCHIVE_LIMIT', 'Materialized link byte budget exceeded.');
      await copyExclusive(link.source, link.target, signal);
    }
    return { files, bytes: total, linksMaterialized: links.length };
  } catch (error) {
    await handle?.close();
    handle = null;
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
}

module.exports = { extractTarGzip, safeName };
