'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { assert, PrepError } = require('./errors');
const { JobLog, redact } = require('./log');
const { targetMatrix } = require('./manifest');
const { validateLocations, directory, regularFile, sha256, copyPrivate, publishFile, cleanupWorkspace } = require('./paths');
const { validateGame } = require('./game');
const { inspectEnvironment, prepareEnvironment } = require('./environment');
const { downloadVerified } = require('./download');
const { extractArchive, verifyIpa } = require('./archive');
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
      let target;
      if (state.kind !== 'preflight') target = this.target(configuration.target);
      else target = this.manifest.targets.find(item => item.id === configuration.target);
      if (state.kind === 'environment') {
        assert(configuration.consent === true, 'CONSENT', 'Explicit dependency download consent is required.');
        stage('environment');
        const result = await prepareEnvironment(this.cache, target, options);
        Object.assign(state, { status: result.ready ? 'succeeded' : 'blocked', stage: 'environment', result: { dependencies: result.dependencies, ready: result.ready }, message: result.ready ? 'Environment ready.' : 'Python prepared. Native tools still require official installers; see the dependency report.' });
      } else {
        stage('environment-check');
        const environment = await inspectEnvironment(this.cache, target, options);
        state.dependencies = environment.dependencies;
        if (state.kind === 'preflight') {
          const problems = [];
          if (!target || !targetMatrix(this.platform, this.arch, this.manifest).hostSupported) problems.push({ code: 'UPSTREAM_BLOCKED', message: this.manifest.reason || 'Unsupported host.' });
          if (!environment.ready) problems.push({ code: 'ENVIRONMENT', message: 'Environment is not ready; inspect each dependency below.' });
          let gameVerified = false;
          try {
            assert(configuration.input && configuration.output, 'FOLDERS_REQUIRED', 'Choose your input and output folders.');
            await validateLocations({ input: configuration.input, output: configuration.output, cache: this.cache });
            stage('validating-files');
            const tree = await validateGame(configuration.input, target, { signal, onFile: progress => stage('validating-files', progress) });
            const free = await fs.statfs(this.cache);
            assert(Number(free.bavail) * Number(free.bsize) > tree.bytes * 2 + 8 * 1024 ** 3, 'DISK_SPACE', 'App cache needs at least two game copies plus 8 GiB free. Output needs another IPA-sized allocation.');
            const outputFree = await fs.statfs(configuration.output);
            assert(Number(outputFree.bavail) * Number(outputFree.bsize) > tree.bytes + 2 * 1024 ** 3, 'DISK_SPACE', 'Output folder has insufficient free space.');
            gameVerified = tree.verification;
          } catch (error) { if (signal.aborted) throw error; problems.push({ code: error.code || 'INPUT', message: error.message }); }
          Object.assign(state, { status: problems.length ? 'blocked' : 'succeeded', stage: 'preflight', result: { ready: problems.length === 0, gameVerified, problems, dependencies: environment.dependencies } });
        } else {
          assert(configuration.consent === true, 'CONSENT', 'Explicit source/shell download consent is required.');
          assert(environment.ready, 'ENVIRONMENT', 'Dependencies are not ready. Run preflight / Prepare Environment first.');
          const locations = await validateLocations({ input: configuration.input, output: configuration.output, cache: this.cache });
          stage('validating-files');
          const tree = await validateGame(locations.input, target, { signal, onFile: progress => stage('validating-files', progress) });
          const available = await fs.statfs(this.cache);
          assert(Number(available.bavail) * Number(available.bsize) > tree.bytes * 2 + 8 * 1024 ** 3, 'DISK_SPACE', 'Not enough free space in the app cache.');
          const outputAvailable = await fs.statfs(locations.output);
          assert(Number(outputAvailable.bavail) * Number(outputAvailable.bsize) > tree.bytes + 2 * 1024 ** 3, 'DISK_SPACE', 'Not enough free space in the output directory.');
          stage('download-source');
          const downloads = path.join(this.cache, 'downloads');
          const source = await downloadVerified(target.source, downloads, { signal, onProgress: progress => stage('download-source', progress) });
          stage('download-shell');
          const shell = await downloadVerified(target.shell, downloads, { signal, onProgress: progress => stage('download-shell', progress) });
          stage('extract-source');
          await extractArchive(environment.python, source, path.join(workspace, 'source'), options);
          stage('validate-shell');
          await verifyIpa(environment.python, shell, target, { ...options, shellOnly: true });
          const sourceRoot = await directory(path.join(workspace, 'source', target.sourceRoot));
          await regularFile(path.join(sourceRoot, target.sourceLicense));
          assert((await fs.readFile(path.join(sourceRoot, 'dm', 'PRODUCT'), 'utf8')).trim() === target.shellInfo.PRODUCT, 'SOURCE_PRODUCT', 'Source PRODUCT does not match the pinned shell.');
          const packer = await regularFile(path.join(sourceRoot, target.packScript));
          stage('copy-input');
          const gameCopy = path.join(workspace, 'own-files');
          await copyPrivate(tree, gameCopy, signal);
          await validateGame(gameCopy, target, { signal });
          stage('pack');
          const staged = path.join(workspace, 'prepared.ipa');
          const { packEnvironment } = require('./environment');
          await runProcess(environment.python, ['-I', packer, shell, gameCopy, staged], { ...options, cwd: sourceRoot, environment: packEnvironment(environment, workspace), timeoutMs: 12 * 60 * 60 * 1000 });
          stage('verify-output');
          const verification = await verifyIpa(environment.python, staged, target, options);
          const hash = await sha256(staged, signal);
          stage('publish');
          const name = `D2R-${target.id}-${id.slice(0, 8)}.ipa`;
          const destination = await publishFile(staged, locations.output, name, signal);
          Object.assign(state, { status: 'succeeded', stage: 'complete', result: { path: destination, sha256: hash, verification, inputVerification: tree.verification, signingRequired: true, resourcesCopiedToPhoneSeparately: target.game.resources, gameVersion: target.game.version, sourceCommit: target.sourceCommit } });
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
