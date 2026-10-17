'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { checkedUrl, artifact } = require('./manifest');
const { regularFile } = require('./paths');
const { assert } = require('./errors');

async function request(url, signal, fetcher) {
  let current = checkedUrl(url).href;
  for (let count = 0; count <= 4; count += 1) {
    const response = await fetcher(current, { redirect: 'manual', signal, headers: { 'User-Agent': 'D2RPrepAssistant/0.1', 'Accept-Encoding': 'identity' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      assert(location, 'DOWNLOAD_REDIRECT', 'Redirect has no location.');
      current = checkedUrl(new URL(location, current).href).href;
      continue;
    }
    assert(response.status === 200 && response.body, 'DOWNLOAD_HTTP', `Publisher returned HTTP ${response.status}.`);
    return response;
  }
  throw new Error('Too many download redirects.');
}

async function downloadVerified(record, directory, { signal, onProgress = () => {}, fetcher = fetch } = {}) {
  artifact(record);
  const algorithm = record.sha256 ? 'sha256' : 'sha512';
  const digest = record[algorithm];
  const maximum = record.bytes || record.maxBytes;
  const destination = path.join(directory, `${digest}.archive`);
  await fs.mkdir(directory, { recursive: true });
  try {
    await regularFile(destination);
    const cachedHash = crypto.createHash(algorithm);
    for await (const chunk of require('node:fs').createReadStream(destination, { signal })) cachedHash.update(chunk);
    const size = (await fs.stat(destination)).size;
    if ((record.bytes ? size === record.bytes : size > 0 && size <= maximum) && cachedHash.digest('hex') === digest) return destination;
    await fs.unlink(destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const partial = path.join(directory, `${digest}.${crypto.randomUUID()}.part`);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(() => controller.abort(new Error('Download timed out after 30 minutes.')), 30 * 60 * 1000);
  let handle;
  try {
    const response = await request(record.url, controller.signal, fetcher);
    const declared = response.headers.get('content-length');
    assert(!declared || (record.bytes ? Number(declared) === record.bytes : Number(declared) > 0 && Number(declared) <= maximum), 'DOWNLOAD_SIZE', 'Publisher Content-Length does not match the verified size budget.');
    const encoding = response.headers.get('content-encoding');
    assert(!encoding || encoding === 'identity', 'DOWNLOAD_ENCODING', 'Compressed HTTP content is not accepted for pinned artifacts.');
    handle = await fs.open(partial, 'wx', 0o600);
    let bytes = 0;
    const hash = crypto.createHash(algorithm);
    for await (const chunk of response.body) {
      controller.signal.throwIfAborted();
      bytes += chunk.length;
      assert(bytes <= maximum, 'DOWNLOAD_SIZE', 'Download exceeds the manifest size budget.');
      hash.update(chunk);
      await handle.writeFile(chunk);
      onProgress({ bytes, total: record.bytes || null });
    }
    assert(record.bytes ? bytes === record.bytes : bytes > 0 && (!declared || bytes === Number(declared)), 'DOWNLOAD_SIZE', 'Incomplete download.');
    assert(hash.digest('hex') === digest, 'DOWNLOAD_HASH', 'Publisher digest mismatch; downloaded bytes were not trusted or executed.');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(partial, destination);
    return destination;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    await handle?.close();
    await fs.rm(partial, { force: true });
  }
}

module.exports = { request, downloadVerified };
