'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { assert, PrepError } = require('./errors');
const { JobLog, redact } = require('./log');
const { targetMatrix } = require('./manifest');
const { validateLocations, directory, regularFile, sha256, copyPrivate, publishFile, publishDirectory, cleanupWorkspace } = require('./paths');
const { validateGame } = require('./game');
const { inspectEnvironment, prepareEnvironment, packEnvironment } = require('./environment');
const { downloadVerified } = require('./download');
const { extractArchive, verifyIpa, verifyAndroidPack, verifyLegacyPack } = require('./archive');
const { runProcess } = require('./process');

class JobEngine extends EventEmitter {
  constructor({ cache, manifest, platform = process.platform, arch = process.arch }) {
    super();
    this.cache = cache;
    this.manifest = manifest;
    this.platform = platform;
    this.arch = arch;
    this.active = null;
    this.last = null;
    this.lastLog = null;
  }

  get busy() { return Boolean(this.active); }

  target(id) {
    const supported = targetMatrix(this.platform, this.arch, this.manifest).targets.find(target => target.id === id);
    assert(supported?.enabled, 'UPSTREAM_BLOCKED', this.manifest.reason || 'Selected target is unavailable on this host.');
    return this.manifest.targets.find(target => target.id === id);
  }

  async initialize() {
    await fs.mkdir(this.cache, { recursive: true, mode: 0o700 });
    await directory(this.cache);
    await fs.mkdir(path.join(this.cache, 'jobs'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.cache, 'logs'), { recursive: true, mode: 0o700 });
  }

  snapshot() {
    return this.active?.state || this.last || { status: 'idle' };
  }

  start(kind, configuration = {}) {
    assert(['preflight', 'environment', 'prepare'].includes(kind), 'JOB_KIND', 'Unknown operation.');
    assert(!this.active, 'BUSY', 'Another operation is running. Cancel it or wait.');
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const state = { id, kind, status: 'running', stage: 'starting', completed: null, total: null };
    const active = { id, controller, state, promise: null };
    this.active = active;
    this.emit('event', { type: 'state', ...state });
    active.promise = this.execute(active, configuration);
    return { id };
  }

  async cancel() {
    if (!this.active) return { cancelled: false };
    this.active.controller.abort(new PrepError('CANCELLED', 'Cancelled by user.'));
    await this.active.promise;
    return { cancelled: true };
  }

  async wait() {
    await this.active?.promise;
    return this.snapshot();
  }

  async runLegacyPackPipeline(romfsPath, packStage, environment, sourceRoot, options, stage) {
    const workAstc = path.join(options.cwd, 'astc-work');
    await fs.mkdir(workAstc, { recursive: true });
    await fs.mkdir(packStage, { recursive: true });

    stage('astc-encode');
    const astcencBin = environment.tools.astcenc;
    assert(astcencBin, 'ASTCENC_MISSING', 'astcenc is required for Legacy Device Pack.');
    const astcPackScript = path.join(sourceRoot, 'dm/tools/astc_pack.py');
    await runProcess(
      environment.python,
      ['-I', astcPackScript, romfsPath, workAstc, '--astcenc', astcencBin, '--preset', 'thorough'],
      { ...options, timeoutMs: 90 * 60 * 1000 }
    );

    stage('casc-pack');
    const cascOverlayScript = path.join(sourceRoot, 'dm/tools/casc_overlay.py');
    const replTsv = path.join(workAstc, 'repl.tsv');
    await regularFile(replTsv);
    await runProcess(
      environment.python,
      ['-I', cascOverlayScript, 'pack', romfsPath, packStage, replTsv, '0-8'],
      { ...options, timeoutMs: 30 * 60 * 1000 }
    );

    stage('astc-finalize');
    const finalizeWrapper = `import os, shutil, sys, runpy
orig_link = getattr(os, 'link', None)
def safe_link(src, dst):
    try:
        if orig_link:
            return orig_link(src, dst)
    except OSError:
        pass
    return shutil.copyfile(src, dst)
os.link = safe_link
pack_stage = sys.argv[1]
script_path = sys.argv[2]
sys.argv = [script_path, 'finalize', pack_stage]
runpy.run_path(script_path, run_name='__main__')
`;
    await runProcess(
      environment.python,
      ['-I', '-c', finalizeWrapper, packStage, astcPackScript],
      { ...options, timeoutMs: 10 * 60 * 1000 }
    );

    return verifyLegacyPack(packStage);
  }

  async execute(active, configuration) {
    const { id, controller, state } = active;
    const signal = controller.signal;
    const workspace = path.join(this.cache, 'jobs', id);
    let log;
    const stage = (name, detail = {}) => {
      signal.throwIfAborted();
      Object.assign(state, { stage: name, completed: null, total: null, bytes: null, name: null }, detail);
      this.emit('event', { type: 'state', ...state });
    };

    try {
      await this.initialize();
      await fs.mkdir(workspace, { mode: 0o700 });
      const temp = path.join(workspace, 'tmp');
      await fs.mkdir(temp);
      log = new JobLog(path.join(this.cache, 'logs', `${id}.log`), [configuration.input, configuration.output, this.cache], line => this.emit('event', { type: 'log', id, line }));
      this.lastLog = log;
      const options = { signal, cwd: workspace, temp, onLog: text => log.append(text) };
      log.append(`Operation ${state.kind}; workspace isolated; originals are never passed to upstream scripts.`);

      const device = configuration.device || 'current';
      let target;
      if (state.kind !== 'preflight') target = this.target(configuration.target);
      else target = this.manifest.targets.find(item => item.id === configuration.target);

      if (state.kind === 'environment') {
        assert(configuration.consent === true, 'CONSENT', 'Explicit dependency download consent is required.');
        stage('environment');
        const result = await prepareEnvironment(this.cache, target, { ...options, device });
        Object.assign(state, {
          status: result.ready ? 'succeeded' : 'blocked',
          stage: 'environment',
          result: { dependencies: result.dependencies, ready: result.ready },
          message: result.ready ? 'Environment ready.' : 'Python prepared. Native tools still require preparation; inspect dependencies.'
        });
      } else {
        stage('environment-check');
        const environment = await inspectEnvironment(this.cache, target, { ...options, device });
        state.dependencies = environment.dependencies;

        if (state.kind === 'preflight') {
          const problems = [];
          if (!target || !targetMatrix(this.platform, this.arch, this.manifest).hostSupported) {
            problems.push({ code: 'UPSTREAM_BLOCKED', message: this.manifest.reason || 'Unsupported host.' });
          }
          if (!environment.ready) {
            problems.push({ code: 'ENVIRONMENT', message: 'Environment is not ready; inspect each dependency below.' });
          }
          let gameVerified = false;
          try {
            assert(configuration.input && configuration.output, 'FOLDERS_REQUIRED', 'Choose your input and output folders.');
            await validateLocations({ input: configuration.input, output: configuration.output, cache: this.cache });
            stage('validating-files');
            const tree = await validateGame(configuration.input, target, { signal, onFile: progress => stage('validating-files', progress) });

            const free = await fs.statfs(this.cache);
            const cacheAvail = Number(free.bavail) * Number(free.bsize);
            const targetKind = target.kind || 'ipa';
            const extraCache = targetKind === 'legacy-pack' ? 4 * 1024 ** 3 : (device === 'legacy' ? 12 * 1024 ** 3 : 8 * 1024 ** 3);
            const extraOutput = targetKind === 'legacy-pack' ? 2 * 1024 ** 3 : (device === 'legacy' ? 4 * 1024 ** 3 : 2 * 1024 ** 3);

            assert(cacheAvail > tree.bytes * 2 + extraCache, 'DISK_SPACE', 'App cache has insufficient free space for workspace.');
            const outputFree = await fs.statfs(configuration.output);
            const outputAvail = Number(outputFree.bavail) * Number(outputFree.bsize);
            assert(outputAvail > tree.bytes + extraOutput, 'DISK_SPACE', 'Output folder has insufficient free space.');
            gameVerified = tree.verification;
          } catch (error) {
            if (signal.aborted) throw error;
            problems.push({ code: error.code || 'INPUT', message: error.message });
          }
          Object.assign(state, {
            status: problems.length ? 'blocked' : 'succeeded',
            stage: 'preflight',
            result: { ready: problems.length === 0, gameVerified, problems, dependencies: environment.dependencies }
          });
        } else {
          // Prepare job
          assert(configuration.consent === true, 'CONSENT', 'Explicit source/tool download consent is required.');
          assert(environment.ready, 'ENVIRONMENT', 'Dependencies are not ready. Run preflight / Prepare Environment first.');
          const locations = await validateLocations({ input: configuration.input, output: configuration.output, cache: this.cache });
          stage('validating-files');
          const tree = await validateGame(locations.input, target, { signal, onFile: progress => stage('validating-files', progress) });

          const available = await fs.statfs(this.cache);
          const cacheAvail = Number(available.bavail) * Number(available.bsize);
          const targetKind = target.kind || 'ipa';
          const extraCache = targetKind === 'legacy-pack' ? 4 * 1024 ** 3 : (device === 'legacy' ? 12 * 1024 ** 3 : 8 * 1024 ** 3);
          const extraOutput = targetKind === 'legacy-pack' ? 2 * 1024 ** 3 : (device === 'legacy' ? 4 * 1024 ** 3 : 2 * 1024 ** 3);
          assert(cacheAvail > tree.bytes * 2 + extraCache, 'DISK_SPACE', 'Not enough free space in the app cache.');
          const outputAvailable = await fs.statfs(locations.output);
          const outputAvail = Number(outputAvailable.bavail) * Number(outputAvailable.bsize);
          assert(outputAvail > tree.bytes + extraOutput, 'DISK_SPACE', 'Not enough free space in the output directory.');

          const downloads = path.join(this.cache, 'downloads');
          stage('download-source');
          const source = await downloadVerified(target.source, downloads, { signal, onProgress: progress => stage('download-source', progress) });

          stage('extract-source');
          await extractArchive(environment.python, source, path.join(workspace, 'source'), options);
          const sourceRoot = await directory(path.join(workspace, 'source', target.sourceRoot));
          await regularFile(path.join(sourceRoot, target.sourceLicense));

          stage('copy-input');
          const gameCopy = path.join(workspace, 'own-files');
          await copyPrivate(tree, gameCopy, signal);
          await validateGame(gameCopy, target, { signal });

          const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

          if (targetKind === 'legacy-pack') {
            const romfsPath = tree.romfsSubdir ? path.join(gameCopy, tree.romfsSubdir) : gameCopy;
            const packStage = path.join(workspace, 'legacy-pack-stage');
            const legacyVerif = await this.runLegacyPackPipeline(romfsPath, packStage, environment, sourceRoot, options, stage);

            const readmeContent = `D2R Legacy Device Pack (v2.3.0 / A14–A16)
=========================================
1. Copy the "Legacy Device Pack" folder into your iPhone / iPad App Documents directory.
2. Pair with a compatible v2.3.0 community IPA (e.g. jiayx v2.3.0).
3. Ensure Switch 1.0.34.0 .data game files are placed in data/.
`;
            await fs.writeFile(path.join(packStage, 'README-NEXT-STEPS.txt'), readmeContent, 'utf8');

            stage('publish');
            const folderName = `D2R-Legacy-Device-Pack-${timestamp}`;
            const destination = await publishDirectory(packStage, locations.output, folderName, signal);

            Object.assign(state, {
              status: 'succeeded',
              stage: 'complete',
              result: {
                path: destination,
                sha256: legacyVerif.sha256,
                bytes: legacyVerif.size,
                artifactKind: 'directory',
                target: 'legacy-pack',
                inputVerification: tree.verification,
                gameVersion: target.game.version,
                sourceCommit: target.sourceCommit
              }
            });
          } else if (targetKind === 'android') {
            stage('android-pack');
            const androidStage = path.join(workspace, 'android-stage');
            await fs.mkdir(androidStage, { recursive: true });
            const androidScript = path.join(sourceRoot, 'dm/tools/d2rm_android.py');
            await runProcess(
              environment.python,
              ['-I', androidScript, gameCopy, androidStage],
              { ...options, cwd: sourceRoot, environment: packEnvironment(environment, workspace), timeoutMs: 12 * 60 * 60 * 1000 }
            );

            stage('verify-output');
            const androidOutDir = path.join(androidStage, 'android');
            const androidVerif = await verifyAndroidPack(androidOutDir);

            const packInfoContent = await fs.readFile(path.join(androidOutDir, 'pack_info.txt'), 'utf8');
            const derivedContent = await fs.readFile(path.join(androidOutDir, 'derived.tsv'), 'utf8');
            const androidDigest = crypto.createHash('sha256').update(packInfoContent).update(derivedContent).digest('hex');

            const readmeContent = `D2R Mobile Android Import Pack (v2.3.0)
======================================
1. Install D2RMobile-android.apk on your Android device (Android 12+, ARM64, Vulkan 1.1).
2. Copy the entire "android" folder to:
   Download/S2X/D2R Mobile/
3. Also copy your Switch RomFS/data folder (including .build.config and all 18 .data files)
   into Download/S2X/D2R Mobile/ right next to "android".
4. Launch D2R Mobile. The app will automatically import and verify files on first start.
`;
            await fs.writeFile(path.join(androidStage, 'README-NEXT-STEPS.txt'), readmeContent, 'utf8');

            stage('publish');
            const folderName = `D2RMobile-android-pack-${timestamp}`;
            const destination = await publishDirectory(androidStage, locations.output, folderName, signal);

            Object.assign(state, {
              status: 'succeeded',
              stage: 'complete',
              result: {
                path: path.join(destination, 'android'),
                bundlePath: destination,
                sha256: androidDigest,
                artifactKind: 'directory',
                target: 'android',
                verification: androidVerif,
                inputVerification: tree.verification,
                resourcesCopiedToPhoneSeparately: target.game.resources,
                gameVersion: target.game.version,
                sourceCommit: target.sourceCommit
              }
            });
          } else {
            // targetKind === 'ipa'
            stage('download-shell');
            const shell = await downloadVerified(target.shell, downloads, { signal, onProgress: progress => stage('download-shell', progress) });

            stage('validate-shell');
            await verifyIpa(environment.python, shell, target, { ...options, shellOnly: true });
            assert((await fs.readFile(path.join(sourceRoot, 'dm', 'PRODUCT'), 'utf8')).trim() === target.shellInfo.PRODUCT, 'SOURCE_PRODUCT', 'Source PRODUCT does not match the pinned shell.');
            const packer = await regularFile(path.join(sourceRoot, target.packScript));

            let extraEnv = {};
            let legacyVerif = null;
            if (device === 'legacy') {
              const romfsPath = path.join(gameCopy, 'RomFS');
              const astcPackDir = path.join(workspace, 'astc-pack');
              legacyVerif = await this.runLegacyPackPipeline(romfsPath, astcPackDir, environment, sourceRoot, options, stage);
              extraEnv = { D2RM_ASTC_PACK: astcPackDir };
            }

            stage('pack');
            const staged = path.join(workspace, 'prepared.ipa');
            await runProcess(
              environment.python,
              ['-I', packer, shell, gameCopy, staged],
              { ...options, cwd: sourceRoot, environment: packEnvironment(environment, workspace, extraEnv), timeoutMs: 12 * 60 * 60 * 1000 }
            );

            stage('verify-output');
            const verification = await verifyIpa(environment.python, staged, target, { ...options, legacy: device === 'legacy' });
            const hash = await sha256(staged, signal);
            const ipaStat = await fs.stat(staged);

            stage('publish');
            if (device === 'legacy') {
              const bundleStage = path.join(workspace, 'bundle-stage');
              await fs.mkdir(bundleStage, { recursive: true });
              const ipaName = `D2RMobile-${target.id}-legacy-${timestamp}.ipa`;
              await fs.copyFile(staged, path.join(bundleStage, ipaName));

              const astcPackDir = path.join(workspace, 'astc-pack', 'Legacy Device Pack');
              const bundleLegacyPack = path.join(bundleStage, 'Legacy Device Pack');
              await fs.cp(astcPackDir, bundleLegacyPack, { recursive: true });

              const readmeContent = `D2R Mobile Legacy Device Bundle (A14–A16)
=========================================
1. Sign and install the included .ipa using Sideloadly or your preferred signing tool.
2. Copy the "Legacy Device Pack" folder into the app's Documents directory on your device.
3. Separately copy your owned 18 Switch .data files into the app.
`;
              await fs.writeFile(path.join(bundleStage, 'README-NEXT-STEPS.txt'), readmeContent, 'utf8');

              const bundleFolderName = `D2RMobile-${target.id}-legacy-bundle-${timestamp}`;
              const destination = await publishDirectory(bundleStage, locations.output, bundleFolderName, signal);

              Object.assign(state, {
                status: 'succeeded',
                stage: 'complete',
                result: {
                  path: path.join(destination, ipaName),
                  bundlePath: destination,
                  sha256: hash,
                  packSha256: legacyVerif?.sha256,
                  bytes: ipaStat.size,
                  artifactKind: 'bundle',
                  verification,
                  inputVerification: tree.verification,
                  signingRequired: true,
                  resourcesCopiedToPhoneSeparately: target.game.resources,
                  gameVersion: target.game.version,
                  sourceCommit: target.sourceCommit
                }
              });
            } else {
              const name = `D2RMobile-${target.id}-prepared-${timestamp}.ipa`;
              const destination = await publishFile(staged, locations.output, name, signal);
              Object.assign(state, {
                status: 'succeeded',
                stage: 'complete',
                result: {
                  path: destination,
                  sha256: hash,
                  bytes: ipaStat.size,
                  verification,
                  inputVerification: tree.verification,
                  signingRequired: true,
                  resourcesCopiedToPhoneSeparately: target.game.resources,
                  gameVersion: target.game.version,
                  sourceCommit: target.sourceCommit
                }
              });
            }
          }
        }
      }
    } catch (error) {
      const cancelled = signal.aborted || error.code === 'CANCELLED';
      Object.assign(state, { status: cancelled ? 'cancelled' : 'failed', code: cancelled ? 'CANCELLED' : error.code || 'ERROR', message: redact(error.message, [configuration.input, configuration.output, this.cache]) });
      if (error.recoveryPath) state.recoveryPath = error.recoveryPath;
      log?.append(`${state.code}: ${state.message}`);
    } finally {
      try { await cleanupWorkspace(workspace, state.recoveryPath); }
      catch { state.cleanupWarning = 'Workspace cleanup failed. Remove the job directory from the app cache after quitting; originals are unaffected.'; }
      this.last = { ...state };
      this.active = null;
      this.emit('event', { type: 'state', ...this.last });
    }
  }
}

module.exports = { JobEngine };
