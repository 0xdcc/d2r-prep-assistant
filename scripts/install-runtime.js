'use strict';

const path = require('node:path');
const { downloadArtifact } = require('@electron/get');
const checksums = require('electron/checksums.json');
const [platform = process.platform, arch = process.arch] = process.argv.slice(2);
if (!['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Invalid runtime platform/architecture.');
console.log('Downloading Electron 44.9.0 from its official release, verifying the npm-bundled SHA-256. This does not install globally or launch Electron.');
downloadArtifact({ version: '44.9.0', artifactName: 'electron', platform, arch, cacheRoot: path.resolve(__dirname, '../.cache/electron'), checksums }).then(filename => console.log(filename)).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
