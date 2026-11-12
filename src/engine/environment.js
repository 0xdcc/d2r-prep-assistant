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
  return {
    PATH: [...new Set(paths), process.env.PATH || process.env.Path || ''].join(path.delimiter),
    CC: tools.compiler || '',
    CXX: compilerCpp || '',
    HOME: workspace,
    USERPROFILE: workspace,
    APPDATA: path.join(workspace, 'appdata'),
    LOCALAPPDATA: path.join(workspace, 'localappdata'),
    DOTNET_CLI_HOME: workspace,
    DOTNET_ROOT: tools.dotnet ? path.dirname(tools.dotnet) : '',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_NOLOGO: '1',
    NUGET_PACKAGES: path.join(workspace, 'nuget'),
    PIP_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
    PYTHONUTF8: '1',
    MAKEFLAGS: '-j2',
    MAX_JOBS: '2'
  };
}

function packEnvironment(inspected, workspace, extraEnv = {}) {
  const env = {
    ...localEnvironment(workspace, inspected.tools, inspected.python),
    VIRTUAL_ENV: inspected.python ? path.dirname(path.dirname(inspected.python)) : '',
    DM_ROOT: path.join(workspace, 'dm-root'),
    D2RM_NO_METAL: '1'
  };
  if (inspected.tools?.astcenc) env.ASTCENC = inspected.tools.astcenc;
  if (inspected.tools?.glslc) env.GLSLC = inspected.tools.glslc;
  if (inspected.tools?.spirvOpt) env.SPIRV_OPT = inspected.tools.spirvOpt;
  if (inspected.tools?.spirvVal) env.SPIRV_VAL = inspected.tools.spirvVal;
  return { ...env, ...extraEnv };
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

async function managedAstcenc(cache, target) {
  const record = recipe(target, 'astcenc');
  if (!record) return null;
  try {
    const root = toolRoot(cache, record);
    const marker = JSON.parse(await fs.readFile(await regularFile(path.join(root, 'provenance.json')), 'utf8'));
    const canonicalName = process.platform === 'win32' ? 'bin/astcenc.exe' : 'bin/astcenc';
    const filename = await regularFile(path.join(root, canonicalName));
    assert(marker.archiveDigest === record.sha256 && marker.executableSha256 === await sha256(filename), 'ASTCENC_CHANGED', 'astcenc provenance differs.');
    return filename;
  } catch { return null; }
}

function vkShaderToolsRoot(cache) {
  return path.join(cache, 'tools', `vk-shader-tools-v2026.4-1.4.363.0-${HOST}`);
}

async function managedVkShaderTools(cache) {
  const root = vkShaderToolsRoot(cache);
  try {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const binDir = path.join(root, 'bin');
    const spirvOpt = await regularFile(path.join(binDir, `spirv-opt${ext}`));
    const spirvVal = await regularFile(path.join(binDir, `spirv-val${ext}`));
    const glslc = await regularFile(path.join(binDir, `glslc${ext}`));
    const marker = JSON.parse(await fs.readFile(await regularFile(path.join(root, '.d2r-prep-provenance.json')), 'utf8'));
    assert(
      marker.tool === 'vk-shader-tools' &&
      marker.glslcSha256 === await sha256(glslc) &&
      marker.spirvOptSha256 === await sha256(spirvOpt) &&
      marker.spirvValSha256 === await sha256(spirvVal),
      'TOOL_CHANGED',
      'vk-shader-tools provenance mismatch.'
    );
    return { spirvOpt, spirvVal, glslc };
  } catch { return null; }
}

async function inspectEnvironment(cache, target, options = {}) {
  const temp = path.join(cache, 'probe-tmp');
  await fs.mkdir(temp, { recursive: true });
  const device = options.device || 'current';
  const targetKind = target?.kind || 'ipa';

  const dependencies = [];
  const tools = {};

  const baseDefinitions = [
    ['python', ['python3.12', 'python3', 'python'], ['--version']],
    ['dotnet', ['dotnet'], ['--list-sdks']],
    ['compiler', ['clang', 'gcc', 'cc'], ['--version']],
    ['spirv', ['spirv-cross'], ['--revision', '--version']],
    ['astcenc', ['astcenc', 'astcenc-avx2', 'astcenc-sse4.1'], ['-help', '-version']],
    ['vkShaderTools', ['spirv-opt'], ['--help']]
  ];

  for (const [id, names, args] of baseDefinitions) {
    options.signal?.throwIfAborted();
    let relevant = true;
    if (target) {
      if (targetKind === 'legacy-pack') {
        relevant = ['python', 'astcenc'].includes(id);
      } else if (targetKind === 'ipa') {
        relevant = ['python', 'compiler', 'dotnet', 'spirv'].includes(id) || (device === 'legacy' && id === 'astcenc');
      } else if (targetKind === 'android') {
        relevant = ['python', 'compiler', 'dotnet', 'vkShaderTools'].includes(id);
      }
    }
    if (!relevant) {
      tools[id] = null;
      continue;
    }

    let detail = '';
    let selected = null;
    let managed = null;

    if (id === 'spirv') {
      managed = await managedSpirv(cache, target);
    } else if (id === 'astcenc') {
      managed = await managedAstcenc(cache, target);
    } else if (id === 'vkShaderTools') {
      const managedVk = await managedVkShaderTools(cache);
      if (managedVk) {
        managed = managedVk.spirvOpt;
        tools.spirvOpt = managedVk.spirvOpt;
        tools.spirvVal = managedVk.spirvVal;
        tools.glslc = managedVk.glslc;
      }
    } else {
      managed = await managedTool(cache, recipe(target, id));
    }

    const candidates = [managed, ...(await Promise.all(names.map(name => executable([name]))))].filter(Boolean);
    for (const candidate of [...new Set(candidates)]) {
      if (process.platform === 'win32' && /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(candidate)) continue;
      try {
        const result = await runProcess(candidate, args, {
          ...options,
          cwd: temp,
          temp,
          environment: localEnvironment(temp, { [id]: candidate }),
          timeoutMs: 15000
        });
        const version = `${result.stdout}${result.stderr}`.trim();
        detail = version.slice(0, 1200);

        let matches = false;
        if (id === 'python') {
          matches = /^Python 3\.12\./.test(version);
        } else if (id === 'dotnet') {
          matches = version.split(/\r?\n/).some(line => /^10\.\d+\.\d+\s+\[/.test(line));
        } else if (id === 'compiler') {
          matches = /clang|gcc|Free Software Foundation|Apple LLVM/i.test(version);
        } else if (id === 'spirv') {
          matches = candidate === managed || /1\.4\.363\.0|1\.4\.357\.0|6c09849fe88c48eaed08413aa022aaa136a3a057/.test(version);
        } else if (id === 'astcenc') {
          matches = candidate === managed || /astcenc|5\.2/i.test(version);
        } else if (id === 'vkShaderTools') {
          if (candidate === managed) {
            matches = true;
          } else {
            // Check if system PATH also has spirv-val and glslc
            const [val, glsl] = await Promise.all([executable(['spirv-val']), executable(['glslc'])]);
            if (val && glsl && version.includes('--trim-capabilities')) {
              matches = true;
              tools.spirvOpt = candidate;
              tools.spirvVal = val;
              tools.glslc = glsl;
            }
          }
        }

        if (matches) {
          selected = candidate;
          break;
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (id === 'spirv' && candidate === managed) {
          selected = candidate;
          detail = 'Pinned SPIRV-Cross source build; executable SHA-256 and provenance verified.';
          break;
        }
        if (id === 'astcenc' && candidate === managed) {
          selected = candidate;
          detail = 'Pinned astcenc 5.2.0 binary; executable SHA-256 and provenance verified.';
          break;
        }
        if (id === 'vkShaderTools' && candidate === managed) {
          selected = candidate;
          detail = 'Pinned vk-shader-tools build; spirv-opt, spirv-val, glslc verified.';
          break;
        }
        detail = error.message;
      }
    }

    tools[id] = selected;

    if (relevant) {
      const automatic = Boolean(
        id === 'spirv' ? recipe(target, 'spirvSource') :
        id === 'astcenc' ? recipe(target, 'astcenc') :
        id === 'vkShaderTools' ? recipe(target, 'shadercSource') :
        recipe(target, id)
      );
      dependencies.push({
        id,
        state: selected ? 'ready' : 'blocked',
        detail: detail || (automatic ? 'Not present. Prepare Environment can acquire the pinned app-owned tool.' : 'Not found. Use the official installer; no privileged installation is performed.'),
        automatic,
        help: id === 'compiler' ? (process.platform === 'darwin' ? 'xcode' : 'compiler') :
              id === 'spirv' ? 'spirvCross' :
              id === 'astcenc' ? 'astcenc' :
              id === 'vkShaderTools' ? 'vulkanTools' : id
      });
    }
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

  let requiredTools = [];
  if (target) {
    if (targetKind === 'legacy-pack') {
      requiredTools = ['python', 'astcenc'];
    } else if (targetKind === 'ipa') {
      requiredTools = ['python', 'compiler', 'dotnet', 'spirv'];
      if (device === 'legacy') requiredTools.push('astcenc');
    } else if (targetKind === 'android') {
      requiredTools = ['python', 'compiler', 'dotnet', 'vkShaderTools'];
    }
  }

  const ready = Boolean(target && python && requiredTools.every(id => Boolean(tools[id])));
  return { dependencies, tools, python, ready };
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
    if (record.format === 'tar.gz') {
      await extractTarGzip(archive, staging, { ...options, maxBytes: 4 * 1024 ** 3, materializeLinks: record.materializeLinks === true, include: record.include || null });
    } else {
      assert(python, 'PYTHON_REQUIRED', 'Prepare the managed Python runtime first.');
      await extractArchive(python, archive, staging, { ...options, maxBytes: 4 * 1024 ** 3 });
    }
    const filename = await regularFile(path.join(staging, record.executable));
    if (process.platform !== 'win32') {
      try { await fs.chmod(filename, 0o755); } catch {}
    }
    await fs.writeFile(path.join(staging, 'provenance.json'), JSON.stringify({ archiveDigest: record.sha256 || record.sha512, url: record.url, license: record.license, executableSha256: await sha256(filename) }), { flag: 'wx', mode: 0o600 });
    await fs.rm(root, { recursive: true, force: true });
    await fs.rename(staging, root);
    return path.join(root, record.executable);
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

async function acquireAstcenc(cache, target, python, options) {
  const existing = await managedAstcenc(cache, target);
  if (existing) return existing;
  const record = recipe(target, 'astcenc');
  assert(record, 'PORTABLE_UNAVAILABLE', 'No astcenc recipe found for this host.');
  options.onLog?.(`Acquiring pinned astcenc 5.2.0 (${record.bytes} bytes).`);
  const archive = await downloadVerified(record, path.join(cache, 'downloads'), options);
  const root = toolRoot(cache, record);
  const staging = path.join(path.dirname(root), `s-${crypto.randomBytes(6).toString('hex')}`);
  await fs.mkdir(path.dirname(root), { recursive: true });
  try {
    assert(python, 'PYTHON_REQUIRED', 'Prepare Python runtime first.');
    await extractArchive(python, archive, staging, { ...options, maxBytes: 1024 ** 3 });

    let workingExe = null;
    const candidates = [record.executable, ...(record.fallbackExecutables || [])];
    for (const rel of candidates) {
      const fullPath = path.join(staging, rel);
      if (process.platform !== 'win32') {
        try { await fs.chmod(fullPath, 0o755); } catch {}
      }
      try {
        await regularFile(fullPath);
        const res = await runProcess(fullPath, ['-help'], { ...options, timeoutMs: 5000 });
        if (res.stdout.includes('astcenc') || res.stderr.includes('astcenc') || res.code === 0) {
          workingExe = rel;
          break;
        }
      } catch {}
    }
    assert(workingExe, 'ASTCENC_FAILED', 'Failed to find a compatible astcenc binary.');

    const canonicalName = process.platform === 'win32' ? 'bin/astcenc.exe' : 'bin/astcenc';
    const canonicalPath = path.join(staging, canonicalName);
    if (workingExe !== canonicalName) {
      await fs.copyFile(path.join(staging, workingExe), canonicalPath);
      if (process.platform !== 'win32') {
        try { await fs.chmod(canonicalPath, 0o755); } catch {}
      }
    }

    await fs.writeFile(
      path.join(staging, 'provenance.json'),
      JSON.stringify({
        archiveDigest: record.sha256,
        url: record.url,
        license: record.license,
        executableSha256: await sha256(canonicalPath),
        workingExe
      }),
      { flag: 'wx', mode: 0o600 }
    );
    await fs.rm(root, { recursive: true, force: true });
    await fs.rename(staging, root);
    return path.join(root, canonicalName);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
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
    await runProcess(cmake, ['-S', source, '-B', build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', `-DCMAKE_MAKE_PROGRAM=${ninja}`, `-DCMAKE_C_COMPILER=${tools.compiler}`, `-DCMAKE_CXX_COMPILER=${environment.CXX || tools.compiler}`, ...(process.platform === 'win32' ? ['-DCMAKE_EXE_LINKER_FLAGS=-static'] : []), '-DSPIRV_CROSS_SHARED=OFF', '-DSPIRV_CROSS_STATIC=ON', '-DSPIRV_CROSS_CLI=ON', '-DSPIRV_CROSS_ENABLE_TESTS=OFF'], { ...options, environment, timeoutMs: 120000 });
    await runProcess(cmake, ['--build', build, '--target', 'spirv-cross', '--parallel', '2'], { ...options, environment, timeoutMs: 30 * 60 * 1000 });
    const name = process.platform === 'win32' ? 'spirv-cross.exe' : 'spirv-cross';
    const binary = await regularFile(path.join(build, name));
    if (process.platform !== 'win32') {
      try { await fs.chmod(binary, 0o755); } catch {}
    }
    await fs.copyFile(binary, path.join(staging, name));
    await fs.writeFile(path.join(staging, 'provenance.json'), JSON.stringify({ sourceSha256: sourceRecord.sha256, sourceCommit: sourceRecord.sourceCommit, executableSha256: await sha256(binary), compiler: tools.compiler, maxThreads: 2 }), { flag: 'wx', mode: 0o600 });
    await fs.rm(root, { recursive: true, force: true });
    await fs.rename(staging, root);
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

async function buildVkShaderTools(cache, target, tools, python, options) {
  const root = vkShaderToolsRoot(cache);
  assert(tools.compiler, 'COMPILER_REQUIRED', 'Compiler is required to build vk-shader-tools.');
  const cmake = await acquireTool(cache, recipe(target, 'cmake'), python, options);
  const ninja = await acquireTool(cache, recipe(target, 'ninja'), python, options);

  options.onLog?.('Acquiring vk-shader-tools sources (shaderc, spirv-headers, spirv-tools, glslang)...');
  const downloads = path.join(cache, 'downloads');
  const shadercRec = recipe(target, 'shadercSource');
  const headersRec = recipe(target, 'spirvHeadersSource');
  const toolsRec = recipe(target, 'spirvToolsSource');
  const glslangRec = recipe(target, 'glslangSource');
  assert(shadercRec && headersRec && toolsRec && glslangRec, 'SOURCE_MISSING', 'Missing reviewed vk-shader-tools source recipes.');

  const shadercZip = await downloadVerified(shadercRec, downloads, options);
  const headersZip = await downloadVerified(headersRec, downloads, options);
  const toolsZip = await downloadVerified(toolsRec, downloads, options);
  const glslangZip = await downloadVerified(glslangRec, downloads, options);

  const staging = path.join(path.dirname(root), `s-${crypto.randomBytes(6).toString('hex')}`);
  const srcStage = path.join(options.cwd, `vk-src-${crypto.randomBytes(4).toString('hex')}`);
  const buildDir = path.join(options.cwd, `vk-build-${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(staging, { recursive: true });
  await fs.mkdir(srcStage, { recursive: true });

  const environment = localEnvironment(options.cwd, { ...tools, cmake, ninja }, python);

  try {
    const sDir = path.join(srcStage, 's');
    const hDir = path.join(srcStage, 'h');
    const tDir = path.join(srcStage, 't');
    const gDir = path.join(srcStage, 'g');
    await extractArchive(python, shadercZip, sDir, options);
    await extractArchive(python, headersZip, hDir, options);
    await extractArchive(python, toolsZip, tDir, options);
    await extractArchive(python, glslangZip, gDir, options);

    const shadercDir = path.join(sDir, shadercRec.sourceRoot);
    const thirdParty = path.join(shadercDir, 'third_party');
    await fs.mkdir(thirdParty, { recursive: true });
    await fs.rename(path.join(hDir, headersRec.sourceRoot), path.join(thirdParty, 'spirv-headers'));
    await fs.rename(path.join(tDir, toolsRec.sourceRoot), path.join(thirdParty, 'spirv-tools'));
    await fs.rename(path.join(gDir, glslangRec.sourceRoot), path.join(thirdParty, 'glslang'));

    options.onLog?.('Configuring vk-shader-tools via CMake...');
    await runProcess(
      cmake,
      [
        '-S', shadercDir,
        '-B', buildDir,
        '-G', 'Ninja',
        `-DCMAKE_MAKE_PROGRAM=${ninja}`,
        `-DCMAKE_C_COMPILER=${tools.compiler}`,
        `-DCMAKE_CXX_COMPILER=${environment.CXX || tools.compiler}`,
        ...(process.platform === 'win32' ? ['-DCMAKE_EXE_LINKER_FLAGS=-static'] : []),
        `-DPython_EXECUTABLE=${python}`,
        `-DPython3_EXECUTABLE=${python}`,
        '-DCMAKE_BUILD_TYPE=Release',
        '-DSHADERC_SKIP_TESTS=ON',
        '-DSHADERC_SKIP_EXAMPLES=ON',
        '-DSHADERC_SKIP_COPYRIGHT_CHECK=ON',
        '-DSHADERC_ENABLE_WERROR_COMPILE=OFF',
        '-DSPIRV_SKIP_TESTS=ON',
        '-DSPIRV_WERROR=OFF'
      ],
      { ...options, environment, timeoutMs: 120000 }
    );

    options.onLog?.('Compiling glslc, spirv-opt, spirv-val...');
    await runProcess(
      cmake,
      ['--build', buildDir, '--target', 'glslc_exe', 'spirv-opt', 'spirv-val', '--parallel', '4'],
      { ...options, environment, timeoutMs: 45 * 60 * 1000 }
    );

    const ext = process.platform === 'win32' ? '.exe' : '';
    const binOut = path.join(staging, 'bin');
    await fs.mkdir(binOut, { recursive: true });

    // Locate binaries
    async function findBuiltBin(name) {
      const candidates = [
        path.join(buildDir, 'glslc', `${name}${ext}`),
        path.join(buildDir, 'bin', `${name}${ext}`),
        path.join(buildDir, 'third_party', 'spirv-tools', 'tools', `${name}${ext}`),
        path.join(buildDir, `${name}${ext}`)
      ];
      for (const candidate of candidates) {
        try {
          await regularFile(candidate);
          return candidate;
        } catch {}
      }
      throw new Error(`Cannot find built binary: ${name}${ext}`);
    }

    const builtGlslc = await findBuiltBin('glslc');
    const builtOpt = await findBuiltBin('spirv-opt');
    const builtVal = await findBuiltBin('spirv-val');

    const destGlslc = path.join(binOut, `glslc${ext}`);
    const destOpt = path.join(binOut, `spirv-opt${ext}`);
    const destVal = path.join(binOut, `spirv-val${ext}`);

    await fs.copyFile(builtGlslc, destGlslc);
    await fs.copyFile(builtOpt, destOpt);
    await fs.copyFile(builtVal, destVal);

    if (process.platform !== 'win32') {
      await fs.chmod(destGlslc, 0o755);
      await fs.chmod(destOpt, 0o755);
      await fs.chmod(destVal, 0o755);
    }

    const testOpt = await runProcess(destOpt, ['--help'], { ...options, environment, timeoutMs: 5000 });
    assert(testOpt.stdout.includes('--trim-capabilities'), 'SPIRV_OPT_CAPABILITIES', 'Built spirv-opt missing --trim-capabilities.');

    await fs.writeFile(
      path.join(staging, '.d2r-prep-provenance.json'),
      JSON.stringify({
        tool: 'vk-shader-tools',
        version: 'v2026.4-1.4.363.0',
        glslcSha256: await sha256(destGlslc),
        spirvOptSha256: await sha256(destOpt),
        spirvValSha256: await sha256(destVal),
        compiler: tools.compiler
      }),
      { flag: 'wx', mode: 0o600 }
    );

    await fs.rm(root, { recursive: true, force: true });
    await fs.rename(staging, root);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(srcStage, { recursive: true, force: true });
    await fs.rm(buildDir, { recursive: true, force: true });
  }
}

async function prepareEnvironment(cache, target, options = {}) {
  assert(target, 'UPSTREAM_BLOCKED', 'No reviewed target available.');
  const inspected = await inspectEnvironment(cache, target, options);
  const tools = { ...inspected.tools };
  const targetKind = target.kind || 'ipa';
  const device = options.device || 'current';

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

  if (targetKind === 'legacy-pack') {
    if (!tools.astcenc) tools.astcenc = await acquireAstcenc(cache, target, python, options);
  } else if (targetKind === 'ipa') {
    if (!tools.compiler && recipe(target, 'compiler')) tools.compiler = await acquireTool(cache, recipe(target, 'compiler'), python, options);
    if (!tools.dotnet && recipe(target, 'dotnet')) tools.dotnet = await acquireTool(cache, recipe(target, 'dotnet'), python, options);
    if (!tools.spirv) await buildSpirv(cache, target, tools, python, options);
    if (device === 'legacy' && !tools.astcenc) tools.astcenc = await acquireAstcenc(cache, target, python, options);
  } else if (targetKind === 'android') {
    if (!tools.compiler && recipe(target, 'compiler')) tools.compiler = await acquireTool(cache, recipe(target, 'compiler'), python, options);
    if (!tools.dotnet && recipe(target, 'dotnet')) tools.dotnet = await acquireTool(cache, recipe(target, 'dotnet'), python, options);
    if (!tools.vkShaderTools) await buildVkShaderTools(cache, target, tools, python, options);
  }

  return inspectEnvironment(cache, target, options);
}

module.exports = {
  MODULES,
  HOST,
  inspectEnvironment,
  prepareEnvironment,
  environmentPath,
  venvPython,
  toolRoot,
  recipe,
  acquireTool,
  acquireAstcenc,
  buildSpirv,
  buildVkShaderTools,
  localEnvironment,
  packEnvironment
};
