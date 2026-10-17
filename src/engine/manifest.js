'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assert } = require('./errors');

const DOWNLOAD_HOSTS = new Set(['github.com', 'codeload.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'downloads.python.org', 'www.python.org', 'builds.dotnet.microsoft.com', 'download.visualstudio.microsoft.com', 'api.nuget.org', 'pypi.org', 'files.pythonhosted.org']);
const HASH = /^[a-f0-9]{64}$/;

function checkedUrl(value) {
  assert(typeof value === 'string' && value.length <= 2048, 'MANIFEST_URL', 'Invalid artifact URL.');
  const parsed = new URL(value);
  assert(parsed.protocol === 'https:' && DOWNLOAD_HOSTS.has(parsed.hostname) && !parsed.username && !parsed.password && !parsed.port && !parsed.hash, 'DOWNLOAD_HOST', 'Download URL/redirect is not on the fixed HTTPS publisher allowlist.');
  return parsed;
}

function artifact(value) {
  assert(value && typeof value === 'object', 'MANIFEST', 'Missing artifact metadata.');
  const parsed = checkedUrl(value.url);
  assert((HASH.test(value.sha256) || /^[a-f0-9]{128}$/.test(value.sha512)) && Number.isSafeInteger(value.bytes || value.maxBytes) && (value.bytes || value.maxBytes) > 0 && (value.bytes || value.maxBytes) <= 8 * 1024 ** 3, 'MANIFEST', 'Artifact needs a real publisher digest and bounded size.');
  assert(!/\/(latest|dev|main|master)(\/|$)/i.test(parsed.pathname), 'MANIFEST', 'Artifact URL must be immutable, not a branch/latest URL.');
  assert(typeof value.license === 'string' && value.license.length > 0, 'MANIFEST', 'Artifact license is required.');
  return value;
}

function relativeName(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length < 512 && !/[\\:\0]/.test(value) && !value.startsWith('/') && value.split('/').every(segment => segment && segment !== '.' && segment !== '..'), 'MANIFEST_PATH', 'Unsafe path in trusted manifest.');
  return value;
}

function validateManifest(value) {
  assert(value?.schemaVersion === 1 && value.status === 'verified' && Array.isArray(value.targets) && Array.isArray(value.portableTools), 'MANIFEST', 'Unsupported upstream manifest schema.');
  assert(['https://github.com/jhaizhou-ops/d2r-mobile', 'https://github.com/d2r-mobile/d2r-mobile'].includes(value.repository), 'MANIFEST', 'Unexpected source repository.');
  const repository = value.repository.slice('https://github.com/'.length);
  const ids = new Set();
  const targets = value.targets.map(entry => {
    const target = { ...value.release, ...entry, portableTools: value.portableTools, pythonWheels: value.pythonWheels };
    assert(['ios18', 'ios26'].includes(target.id) && !ids.has(target.id), 'MANIFEST', 'Invalid/duplicate target.');
    ids.add(target.id);
    assert(/^[a-f0-9]{40}$/.test(target.sourceCommit), 'MANIFEST', 'Source commit must be immutable.');
    artifact(target.source);
    artifact(target.shell);
    assert(target.source.url === `https://codeload.github.com/${repository}/zip/${target.sourceCommit}`, 'MANIFEST', 'Source archive must identify the exact repository commit.');
    assert(target.shell.cleanShell === true && target.shell.url.startsWith(`${value.repository}/releases/download/${target.tag}/`) && target.shell.url.endsWith(target.id === 'ios18' ? '/D2RMobile-shell-ios18-build-input.zip' : '/D2RMobile-shell-build-input.zip'), 'MANIFEST', 'Clean-shell provenance/target mismatch.');
    assert(target.sourceRoot === `d2r-mobile-${target.sourceCommit}` && target.packScript === 'dm/tools/d2rm_pack.py', 'MANIFEST', 'Unexpected upstream entrypoint.');
    relativeName(target.sourceLicense);
    assert(target.game?.version === '1.0.34.0' && target.game.internalVersion === '3.3.94012' && target.game.expansion === true, 'MANIFEST', 'Game version/expansion contract missing.');
    assert(target.game.programs?.length === 3 && ['main', 'sdk', 'subsdk0'].every(name => target.game.programs.some(file => file.path === `ExeFS/${name}` && HASH.test(file.sha256))), 'MANIFEST', 'Three upstream ExeFS hashes are required.');
    assert(target.game.resources?.length === 18 && new Set(target.game.resources).size === 18 && target.game.resources.every(name => /^\d{2}-\d{8}\.data$/.test(name)), 'MANIFEST', '18 resource presence records are required.');
    assert(target.shellInfo?.PRODUCT === '3.3.94012-r44' && /^[a-f0-9]{12}$/.test(target.shellInfo.CHAIN) && target.shellInfo.KIND === 'ios' && target.shellInfo.SPIRV_CROSS === '1.4.357.0' && /^[a-f0-9]{16}$/.test(target.shellInfo.SHADER_SRC), 'MANIFEST', 'Shell product/chain contract missing.');
    assert(target.shellManifest?.length > 20, 'MANIFEST', 'Shell member requirements missing.');
    target.shellManifest.forEach(name => relativeName(name.replace(/\/$/, '')));
    assert(target.minimumOS === (target.id === 'ios18' ? '18.0' : '26.0'), 'MANIFEST', 'Shell minimum OS mismatch.');
    const required = new Set(['pillow', 'numpy', 'lz4', 'capstone', 'unicorn']);
    for (const dependency of target.python?.requirements || []) {
      assert(required.delete(dependency.name) && /^\d+(\.\d+){1,3}$/.test(dependency.version), 'MANIFEST', 'Python dependencies require exact versions.');
      if (dependency.hashes) assert(dependency.hashes.length > 0 && dependency.hashes.every(hash => HASH.test(hash)), 'MANIFEST', 'Invalid Python wheel hashes.');
    }
    assert(required.size === 0 && target.dotnetSdkPrefix === '10.' && target.spirvVersionIncludes === '1.4.357.0', 'MANIFEST', 'Tool compatibility metadata missing.');
    return target;
  });
  assert(targets.length === 2, 'MANIFEST', 'Both real iOS targets are required.');
  for (const tool of value.portableTools) {
    artifact(tool);
    assert(['python', 'dotnet', 'compiler', 'cmake', 'ninja', 'spirvSource'].includes(tool.id) && ['win32-x64', 'darwin-arm64', 'darwin-x64'].includes(tool.host), 'MANIFEST', 'Invalid portable tool host.');
    assert(['zip', 'tar.gz'].includes(tool.format), 'MANIFEST', 'Unsupported portable format.');
    relativeName(tool.executable);
  }
  return { ...value, targets };
}

function loadManifest(filename) {
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  value.portableTools = JSON.parse(fs.readFileSync(path.join(path.dirname(filename), 'portable.json'), 'utf8')).tools;
  value.pythonWheels = JSON.parse(fs.readFileSync(path.join(path.dirname(filename), 'python-wheels.json'), 'utf8'));
  for (const wheels of Object.values(value.pythonWheels.hosts)) for (const wheel of wheels) {
    artifact(wheel);
    assert(/^[a-zA-Z0-9_.-]+\.whl$/.test(wheel.filename) && checkedUrl(wheel.url).hostname === 'files.pythonhosted.org', 'MANIFEST', 'Invalid wheel filename/publisher.');
  }
  return validateManifest(value);
}

function targetMatrix(platform, arch, manifest) {
  const hostSupported = platform === 'win32' && arch === 'x64' || platform === 'darwin' && ['arm64', 'x64'].includes(arch);
  return { hostSupported, targets: ['ios18', 'ios26'].map(id => ({ id, enabled: hostSupported && manifest.targets.some(target => target.id === id), reason: hostSupported ? '' : 'Use Windows x64 or macOS arm64/x64.' })), nativeMac: { enabled: false, reason: platform === 'win32' ? 'Windows cannot build a native Mac executable.' : 'Native Mac game builds (Apple silicon + Xcode) are not included in v0.1; use upstream mac_app.sh separately.' } };
}

module.exports = { DOWNLOAD_HOSTS, checkedUrl, artifact, relativeName, validateManifest, loadManifest, targetMatrix };
