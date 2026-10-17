'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { packager } = require('@electron/packager');

async function main() {
  const [platform, arch] = process.argv.slice(2);
  if (!(['win32', 'darwin'].includes(platform) && ['x64', 'arm64'].includes(arch)) || platform === 'win32' && arch !== 'x64') throw new Error('Supported bundles: win32 x64, darwin arm64 or darwin x64.');
  const root = path.resolve(__dirname, '..');
  const { version } = require('../package.json');
  const artifacts = path.join(root, 'artifacts');
  const staging = path.join(artifacts, `.package-${crypto.randomUUID()}`);
  await fs.mkdir(staging, { recursive: true });
  try {
    for (const name of ['src', 'manifests', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses', 'STATUS.json']) await fs.cp(path.join(root, name), path.join(staging, name), { recursive: true, errorOnExist: true, force: false, filter: source => !source.split(path.sep).includes('__pycache__') && !source.endsWith('.pyc') });
    await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify({ name: 'd2r-prep-assistant', productName: 'D2R Prep Assistant', version, main: 'src/main.js', license: 'MIT', author: '@0xdcc' }, null, 2));
    const result = await packager({ dir: staging, out: artifacts, platform, arch, name: 'D2R Prep Assistant', executableName: 'D2RPrepAssistant', electronVersion: '44.9.0', appVersion: version, appBundleId: 'com.d2rmobileguide.prep', appCategoryType: 'public.app-category.utilities', overwrite: false, prune: false, asar: false, download: { cacheRoot: path.join(root, '.cache', 'electron'), checksums: require('electron/checksums.json') }, osxSign: false, osxNotarize: false, win32metadata: { CompanyName: '@0xdcc', FileDescription: 'Local-only D2R preparation assistant', ProductName: 'D2R Prep Assistant' } });
    for (const folder of result) console.log(`Unsigned helper bundle: ${folder}`);
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

main().catch(error => { console.error(`Packaging failed: ${error.stack || error.message}\nRuntime cache: ${path.resolve(__dirname, '../.cache/electron')}\nNo global install or proxy changes were attempted.`); process.exitCode = 1; });
