'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { assert } = require('./errors');

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function noLinks(candidate) {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const info = await fs.lstat(cursor);
    assert(!info.isSymbolicLink(), 'UNSAFE_LINK', `Symbolic links/junctions are not allowed: ${cursor}`);
  }
  return absolute;
}

async function directory(candidate) {
  const absolute = await noLinks(candidate);
  assert((await fs.stat(absolute)).isDirectory(), 'NOT_DIRECTORY', 'Choose an existing directory.');
  assert((await fs.realpath(absolute)) === absolute, 'NON_CANONICAL', 'Choose the real directory, not an alias.');
  return absolute;
}

async function regularFile(candidate) {
  const absolute = await noLinks(candidate);
  const info = await fs.lstat(absolute);
  assert(info.isFile() && info.nlink === 1, 'UNSAFE_FILE', 'Choose a regular file without hard links.');
  return absolute;
}

async function scanTree(root, { signal, maxFiles = 100000, maxBytes = 160 * 1024 ** 3 } = {}) {
  const resolved = await directory(root);
  const entries = [];
  let bytes = 0;
  async function visit(folder) {
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const absolute = path.join(folder, item.name);
      const info = await fs.lstat(absolute);
      assert(!info.isSymbolicLink(), 'UNSAFE_LINK', `Input contains a symbolic link: ${absolute}`);
      assert(info.isFile() || info.isDirectory(), 'UNSAFE_FILE', 'Input contains a special device or socket.');
      assert(info.isDirectory() || info.nlink === 1, 'UNSAFE_FILE', 'Hard-linked inputs are not supported.');
      assert(entries.length < maxFiles, 'TREE_LIMIT', 'Too many input files.');
      entries.push({ path: path.relative(resolved, absolute), directory: info.isDirectory(), bytes: info.size });
      if (info.isDirectory()) await visit(absolute);
      else bytes += info.size;
      assert(bytes <= maxBytes, 'TREE_LIMIT', 'Input exceeds the managed workspace size limit.');
    }
  }
  await visit(resolved);
  return { root: resolved, entries, bytes };
}

async function validateLocations({ input, output, cache }) {
  const inputPath = await directory(input);
  const outputPath = await directory(output);
  const cachePath = await directory(cache);
  for (const [first, second] of [[inputPath, outputPath], [inputPath, cachePath], [outputPath, cachePath]]) {
    assert(!inside(first, second) && !inside(second, first), 'PATH_OVERLAP', 'Input, output and app cache must be separate, non-nested folders.');
  }
  await fs.access(outputPath, require('node:fs').constants.W_OK);
  return { input: inputPath, output: outputPath, cache: cachePath };
}

async function sha256(filename, signal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of require('node:fs').createReadStream(filename, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

async function copyPrivate(tree, destination, signal) {
  signal?.throwIfAborted();
  await fs.mkdir(destination, { recursive: false });
  try {
  for (const entry of tree.entries) {
    signal?.throwIfAborted();
    const source = path.join(tree.root, entry.path);
    await noLinks(source);
    const target = path.join(destination, entry.path);
    assert(inside(destination, target), 'PATH_ESCAPE', 'Input path escapes the workspace.');
    if (entry.directory) await fs.mkdir(target);
    else {
      await regularFile(source);
      await copyExclusive(source, target, signal);
      assert((await fs.stat(target)).size === entry.bytes, 'INPUT_CHANGED', 'Input changed during copy; retry with idle source files.');
    }
  }
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
}

async function copyExclusive(source, destination, signal) {
  signal?.throwIfAborted();
  const handle = await fs.open(destination, 'wx', 0o600);
  try {
    await pipeline(createReadStream(source), handle.createWriteStream(), { signal });
  } catch (error) {
    await handle.close();
    await fs.rm(destination, { force: true });
    throw error;
  }
}

async function publishFile(staged, outputDirectory, filename, signal) {
  assert(path.basename(filename) === filename && /^[a-zA-Z0-9_.-]+\.ipa$/.test(filename), 'OUTPUT_NAME', 'Invalid output name.');
  await directory(outputDirectory);
  const destination = path.join(outputDirectory, filename);
  const partial = path.join(outputDirectory, `.d2r-${crypto.randomUUID()}.partial`);
  let partialCreated = false;
  try {
    await copyExclusive(staged, partial, signal);
    partialCreated = true;
    const handle = await fs.open(partial, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    signal?.throwIfAborted();
    try { await fs.link(partial, destination); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL'].includes(error.code)) throw error;
      await copyExclusive(partial, destination, signal);
      const published = await fs.open(destination, 'r+');
      try { await published.sync(); } finally { await published.close(); }
    }
  } catch (error) {
    error.recoveryPath = staged;
    throw error;
  } finally {
    if (partialCreated) await fs.rm(partial, { force: true });
  }
  return destination;
}

async function cleanupWorkspace(workspace, recoveryPath) {
  if (recoveryPath) {
    assert(path.dirname(recoveryPath) === workspace, 'RECOVERY_PATH', 'Recovery file must remain inside its job workspace.');
    for (const entry of await fs.readdir(workspace)) {
      if (path.join(workspace, entry) !== recoveryPath) await fs.rm(path.join(workspace, entry), { recursive: true, force: true, maxRetries: 3 });
    }
  } else await fs.rm(workspace, { recursive: true, force: true, maxRetries: 3 });
}

module.exports = { inside, noLinks, directory, regularFile, scanTree, validateLocations, sha256, copyPrivate, copyExclusive, publishFile, cleanupWorkspace };
