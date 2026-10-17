'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { executable, runProcess } = require('./process');
const { assert } = require('./errors');
const { regularFile, sha256, directory } = require('./paths');
const { downloadVerified } = require('./download');
const { extractArchive } = require('./archive');
const { extractTarGzip } = require('./tar');

const MODULES = { pillow: 'PIL', numpy: 'numpy', lz4: 'lz4', capstone: 'capstone', unicorn: 'unicorn' };
const HOST = `${process.platform}-${process.arch}`;

function environmentPath(cache, target) {
  const key = crypto.createHash('sha256').update(JSON.stringify({ python: target.python, host: HOST })).digest('hex').slice(0, 20);
  return path.join(cache, 'environments', key);
}

function venvPython(root) {
  return process.platform === 'win32' ? path.join(root, 'Scripts', 'python.exe') : path.join(root, 'bin', 'python');
}

function toolRoot(cache, record) {
  return path.join(cache, 'tools', `${record.id}-${(record.sha256 || record.sha512).slice(0, 20)}`);
}

function recipe(target, id) {
  return target?.portableTools?.find(record => record.id === id && record.host === HOST);
}

async function managedTool(cache, record) {
  if (!record) return null;
  try {
    const root = toolRoot(cache, record);
    const marker = JSON.parse(await fs.readFile(await regularFile(path.join(root, 'provenance.json')), 'utf8'));
    const filename = await regularFile(path.join(root, record.executable));
    assert(marker.archiveDigest === (record.sha256 || record.sha512) && marker.executableSha256 === await sha256(filename), 'TOOL_CHANGED', 'Managed tool changed; prepare it again.');
    return filename;
  } catch { return null; }
}

function localEnvironment(workspace, tools = {}, python = tools.python) {
  const paths = [python, ...Object.values(tools)].filter(Boolean).map(filename => path.dirname(filename));
  const compilerCpp = tools.compiler?.replace(/(clang|gcc|cc)(\.exe)?$/, (_match, name, extension = '') => `${{ clang: 'clang++', gcc: 'g++', cc: 'c++' }[name]}${extension}`);
  return { PATH: [...new Set(paths), process.env.PATH || process.env.Path || ''].join(path.delimiter), CC: tools.compiler || '', CXX: compilerCpp || '', HOME: workspace, USERPROFILE: workspace, APPDATA: path.join(workspace, 'appdata'), LOCALAPPDATA: path.join(workspace, 'localappdata'), DOTNET_CLI_HOME: workspace, DOTNET_ROOT: tools.dotnet ? path.dirname(tools.dotnet) : '', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_NOLOGO: '1', NUGET_PACKAGES: path.join(workspace, 'nuget'), PIP_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null', PYTHONUTF8: '1', MAKEFLAGS: '-j2', MAX_JOBS: '2' };
}

function packEnvironment(inspected, workspace) {
  return { ...localEnvironment(workspace, inspected.tools, inspected.python), VIRTUAL_ENV: path.dirname(path.dirname(inspected.python)), DM_ROOT: path.join(workspace, 'dm-root'), D2RM_NO_METAL: '1' };
}

async function inspectEnvironment(cache, target, options = {}) {
  const temp = path.join(cache, 'probe-tmp');
  await fs.mkdir(temp, { recursive: true });
  const dependencies = [];
  const tools = {};
  const definitions = [
    ['python', ['python3.12', 'python3', 'python'], ['--version']],
    ['dotnet', ['dotnet'], ['--list-sdks']],
    ['compiler', ['clang', 'gcc', 'cc'], ['--version']],
    ['spirv', ['spirv-cross'], ['--revision']]
  ];
  for (const [id, names, args] of definitions) {
    options.signal?.throwIfAborted();
    let detail = '';
    let selected = null;
    const managed = id === 'spirv' ? await managedSpirv(cache, target) : await managedTool(cache, recipe(target, id));
    const candidates = [managed, ...await Promise.all(names.map(name => executable([name])))].filter(Boolean);
    for (const candidate of [...new Set(candidates)]) {
      if (process.platform === 'win32' && /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(candidate)) continue;
      try {
        const result = await runProcess(candidate, args, { ...options, cwd: temp, temp, environment: localEnvironment(temp, { [id]: candidate }), timeoutMs: 15000 });
        const version = `${result.stdout}${result.stderr}`.trim();
        detail = version.slice(0, 1200);
        const matches = id === 'python' ? /^Python 3\.12\./.test(version) : id === 'dotnet' ? version.split(/\r?\n/).some(line => /^10\.\d+\.\d+\s+\[/.test(line)) : id === 'compiler' ? /clang|gcc|Free Software Foundation|Apple LLVM/i.test(version) : candidate === managed || /1\.4\.357\.0|6c09849fe88c48eaed08413aa022aaa136a3a057/.test(version);
        if (matches) { selected = candidate; break; }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (id === 'spirv' && candidate === managed) { selected = candidate; detail = 'Pinned SPIRV-Cross source build; executable SHA-256 and provenance verified. Upstream also checks translated shader digest.'; break; }
        detail = error.message;
      }
    }
    tools[id] = selected;
    const automatic = Boolean(recipe(target, id === 'spirv' ? 'spirvSource' : id));
    dependencies.push({ id, state: selected ? 'ready' : 'blocked', detail: detail || (automatic ? 'Not present. Prepare Environment can acquire the pinned app-owned tool.' : 'Not found. Use the official installer; no privileged installation is performed.'), automatic, help: id === 'compiler' ? process.platform === 'darwin' ? 'xcode' : 'llvm' : id === 'spirv' ? 'spirv' : id });
  }
  let python = null;
  if (target) {
    const managedPython = venvPython(environmentPath(cache, target));
    try {
      const requirements = target.python.requirements.map(item => [item.name, item.version]);
      const script = 'import importlib,importlib.metadata,json,sys; packages=json.loads(sys.argv[1]); [importlib.import_module(name) for name in ["PIL","numpy","lz4","capstone","unicorn"]]; print(json.dumps({name:importlib.metadata.version(name) for name,version in packages})); sys.exit(0 if sys.version_info[:2]==(3,12) and all(importlib.metadata.version(name)==version for name,version in packages) else 2)';
      await runProcess(managedPython, ['-I', '-c', script, JSON.stringify(requirements)], { ...options, cwd: temp, temp, environment: localEnvironment(temp, tools), timeoutMs: 20000 });
      python = managedPython;
      dependencies.push({ id: 'pythonPackages', state: 'ready', detail: requirements.map(item => item.join('==')).join(', ') });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      dependencies.push({ id: 'pythonPackages', state: 'blocked', detail: `App-owned Python 3.12 environment needs preparation. ${error.message}`, help: 'python', automatic: Boolean(target.pythonWheels?.hosts[HOST]) });
    }
  }
  return { dependencies, tools, python, ready: Boolean(target && python && Object.values(tools).every(Boolean)) };
}

async function acquireTool(cache, record, python, options) {
  const existing = await managedTool(cache, record);
  if (existing) return existing;
  assert(record, 'PORTABLE_UNAVAILABLE', 'No reviewed portable tool recipe exists for this host. Use the official installer.');
  options.onLog?.(`Acquiring pinned ${record.id} (${record.bytes || `maximum ${record.maxBytes}`} bytes).`);
  const archive = await downloadVerified(record, path.join(cache, 'downloads'), options);
  const root = toolRoot(cache, record);
  const staging = path.join(path.dirname(root), `s-${crypto.randomBytes(6).toString('hex')}`);
  await fs.mkdir(path.dirname(root), { recursive: true });
  try {
    if (record.format === 'tar.gz') await extractTarGzip(archive, staging, { ...options, maxBytes: 4 * 1024 ** 3, materializeLinks: record.materializeLinks === true, include: record.include || null });
    else {
      assert(python, 'PYTHON_REQUIRED', 'Prepare the managed Python runtime first.');
      await extractArchive(python, archive, staging, { ...options, maxBytes: 4 * 1024 ** 3 });
    }
    const filename = await regularFile(path.join(staging, record.executable));
    await fs.writeFile(path.join(staging, 'provenance.json'), JSON.stringify({ archiveDigest: record.sha256 || record.sha512, url: record.url, license: record.license, executableSha256: await sha256(filename) }), { flag: 'wx', mode: 0o600 });
    await fs.rm(root, { recursive: true, force: true });
    await fs.rename(staging, root);
    return path.join(root, record.executable);
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

function spirvRoot(cache, target) {
  const record = recipe(target, 'spirvSource');
  return record ? path.join(cache, 'tools', `spirv-build-${HOST}-${record.sha256.slice(0, 20)}`) : null;
}

async function managedSpirv(cache, target) {
  const root = spirvRoot(cache, target);
  if (!root) return null;
  try {
    const filename = await regularFile(path.join(root, process.platform === 'win32' ? 'spirv-cross.exe' : 'spirv-cross'));
    const record = JSON.parse(await fs.readFile(await regularFile(path.join(root, 'provenance.json')), 'utf8'));
    assert(record.sourceSha256 === recipe(target, 'spirvSource').sha256 && record.executableSha256 === await sha256(filename), 'SPIRV_CHANGED', 'SPIRV-Cross provenance differs.');
    return filename;
  } catch { return null; }
}

async function buildSpirv(cache, target, tools, python, options) {
  const sourceRecord = recipe(target, 'spirvSource');
  assert(sourceRecord && tools.compiler, 'COMPILER_REQUIRED', 'Install Apple Command Line Tools on macOS (xcode-select --install), then retry. Windows uses app-owned LLVM-MinGW.');
  const sourceFile = await acquireTool(cache, sourceRecord, python, options);
  const cmake = await acquireTool(cache, recipe(target, 'cmake'), python, options);
  const ninja = await acquireTool(cache, recipe(target, 'ninja'), python, options);
  const source = path.dirname(sourceFile);
  const root = spirvRoot(cache, target);
  const staging = path.join(path.dirname(root), `s-${crypto.randomBytes(6).toString('hex')}`);
  const build = path.join(options.cwd, 'spirv-build');
  await fs.mkdir(staging);
  const environment = localEnvironment(options.cwd, { ...tools, cmake, ninja }, python);
  try {
    await runProcess(cmake, ['-S', source, '-B', build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', `-DCMAKE_MAKE_PROGRAM=${ninja}`, `-DCMAKE_C_COMPILER=${tools.compiler}`, `-DCMAKE_CXX_COMPILER=${environment.CXX || tools.compiler}`, '-DSPIRV_CROSS_SHARED=OFF', '-DSPIRV_CROSS_STATIC=ON', '-DSPIRV_CROSS_CLI=ON', '-DSPIRV_CROSS_ENABLE_TESTS=OFF'], { ...options, environment, timeoutMs: 120000 });
    await runProcess(cmake, ['--build', build, '--target', 'spirv-cross', '--parallel', '2'], { ...options, environment, timeoutMs: 30 * 60 * 1000 });
    const name = process.platform === 'win32' ? 'spirv-cross.exe' : 'spirv-cross';
    const binary = await regularFile(path.join(build, name));
    await fs.copyFile(binary, path.join(staging, name));
    await fs.writeFile(path.join(staging, 'provenance.json'), JSON.stringify({ sourceSha256: sourceRecord.sha256, sourceCommit: sourceRecord.sourceCommit, executableSha256: await sha256(binary), compiler: tools.compiler, maxThreads: 2 }), { flag: 'wx', mode: 0o600 });
    await fs.rm(root, { recursive: true, force: true });
    await fs.rename(staging, root);
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

async function prepareEnvironment(cache, target, options) {
  assert(target, 'UPSTREAM_BLOCKED', 'No reviewed target available.');
  const inspected = await inspectEnvironment(cache, target, options);
  const tools = { ...inspected.tools };
  if (!tools.python) tools.python = await acquireTool(cache, recipe(target, 'python'), null, options);
  const root = environmentPath(cache, target);
  if (!inspected.python) {
    const wheels = target.pythonWheels?.hosts[HOST];
    assert(wheels?.length === 5, 'WHEELS_UNAVAILABLE', 'No reviewed Python 3.12 wheels for this architecture. Automatic environment preparation supports Windows x64 and macOS arm64.');
    await fs.mkdir(path.dirname(root), { recursive: true });
    await fs.rm(root, { recursive: true, force: true });
    try {
      const environment = localEnvironment(options.cwd, tools);
      await runProcess(tools.python, ['-I', '-m', 'venv', '--copies', root], { ...options, environment, timeoutMs: 120000 });
      const wheelhouse = path.join(root, 'wheelhouse');
      await fs.mkdir(wheelhouse);
      for (const wheel of wheels) {
        const downloaded = await downloadVerified(wheel, path.join(cache, 'downloads'), options);
        await fs.copyFile(downloaded, path.join(wheelhouse, wheel.filename), require('node:fs').constants.COPYFILE_EXCL);
      }
      const lock = path.join(root, 'requirements.lock');
      await fs.writeFile(lock, wheels.map(wheel => `${wheel.name}==${wheel.version} --hash=sha256:${wheel.sha256}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
      await runProcess(venvPython(root), ['-I', '-m', 'pip', '--isolated', 'install', '--no-index', '--find-links', wheelhouse, '--require-hashes', '--only-binary=:all:', '--no-deps', '--no-input', '--no-cache-dir', '-r', lock], { ...options, environment, timeoutMs: 10 * 60 * 1000 });
      await fs.writeFile(path.join(root, 'provenance.json'), JSON.stringify({ wheels, interpreter: tools.python, installer: 'venv + bundled ensurepip; offline hash-locked wheels only' }), { flag: 'wx', mode: 0o600 });
    } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
  }
  const python = venvPython(root);
  if (!tools.compiler && recipe(target, 'compiler')) tools.compiler = await acquireTool(cache, recipe(target, 'compiler'), python, options);
  if (!tools.dotnet && recipe(target, 'dotnet')) tools.dotnet = await acquireTool(cache, recipe(target, 'dotnet'), python, options);
  if (!tools.spirv) await buildSpirv(cache, target, tools, python, options);
  return inspectEnvironment(cache, target, options);
}

module.exports = { MODULES, HOST, inspectEnvironment, prepareEnvironment, environmentPath, venvPython, toolRoot, recipe, acquireTool, localEnvironment, packEnvironment };
