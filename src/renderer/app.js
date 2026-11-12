'use strict';

const elements = id => document.getElementById(id);
const chinese = {};
document.querySelectorAll('[data-i18n]').forEach(element => { chinese[element.dataset.i18n] = element.textContent; });
const english = {
  workspace: 'PREPARATION WORKSPACE',
  step0: 'Target & Output',
  step0sub: 'Choose your destination',
  step1: 'Your Game Files',
  step1sub: 'Always on your computer',
  step2: 'Environment Check',
  step2sub: 'Verify before preparing',
  step3: 'Prepare & Result',
  step3sub: 'A traceable local job',
  local: 'Local processing · No uploads',
  localSub: 'No account. No cloud game files. Saves are never processed.',
  eyebrow: 'YOUR FILES. YOUR DEVICE.',
  destination: 'What are we preparing?',
  outputs: 'OUTPUT TYPE',
  firstRelease: '4 WORKFLOWS',
  ipaDesc: 'Prepare iOS IPAs, Legacy texture packs, or Android import folders from your own files.',
  notAvailable: 'NOT AVAILABLE',
  nativeMac: 'Native Mac app',
  systemTarget: 'Target Workflow',
  targetIos26: 'iOS / iPadOS 26+ IPA (Metal 4)',
  targetIos18: 'iOS / iPadOS 18–25 IPA (Metal 3)',
  targetLegacyPack: 'Legacy Device Pack (iPhone 13 Pro / 14 / 15 · A14–A16)',
  targetAndroid: 'Android v2.3.0 Import Folder (android/)',
  targetNote: 'Matches upstream d2r-mobile v2.3.0 pinned source and clean shells. Fully local.',
  deviceLabel: 'Device compatibility reference',
  currentDevice: 'A17 Pro / M1+ (Standard BC textures)',
  legacyDevice: 'A14–A16 · ≥6GB (Auto-build paired Legacy Device Pack + ASTC IPA)',
  unsupportedDevice: 'iPhone 13 4GB / A12Z / Android <12GB (Unsupported)',
  outputFolder: 'Output folder',
  notSelected: 'Not selected',
  chooseFolder: 'Choose folder',
  noOverwrite: 'Each job creates a unique name or directory. Existing files are never overwritten.',
  ownFiles: 'Use your own game files',
  ownNotice: 'Local files only. No game downloads or save processing.',
  inputFolder: 'Game data folder',
  requiredLayout: 'Required folder structure',
  layoutNote: 'IPA and Android need ExeFS + RomFS; standalone Legacy Pack needs RomFS only.',
  strictVersion: 'Exact version, not an ownership checkbox',
  versionInfo: 'Switch 1.0.34.0 / internal 3.3.94012 + expansion. Three upstream program SHA-256 checks; 18 nonempty resource archives and PSV extents. No full resource hashes are published: resources are NOT cryptographically verified.',
  privateCopy: 'Only needed files are privately copied. Upstream never receives the original folder. Links and overlapping paths are rejected.',
  preflightTitle: 'Before starting, check the essentials.',
  runCheck: 'Run check',
  checkIntro: 'Check dependencies, actual input version, path safety and disk space for your selected workflow.',
  prepareEnv: 'Prepare isolated environment',
  envNote: 'Auto-prepares Python 3.12, five pinned wheels, .NET 10, LLVM-MinGW, SPIRV-Cross, astcenc 5.2.0, or vk-shader-tools.',
  envConsent: 'Allow downloading pinned portable tools and PyPI wheels, and compiling tools locally.',
  prepareEnvButton: 'Prepare environment',
  readyTitle: 'Only verifiable processes are worth starting.',
  runIntro: 'Pinned sources and clean shells → private copy → real upstream packer → structure & manifest verification → publish unique result.',
  buildConsent: 'Allow downloading pinned source and clean shell, plus upstream NuGet build dependencies; no game content.',
  startPrepare: 'Start local preparation ↗',
  cancel: 'Cancel job',
  exportLog: 'Export redacted log',
  idle: 'Not started',
  realProgress: 'Real stage events only. No invented countdown.',
  verifiedResult: 'Artifact verified, ready for next steps.',
  showFile: 'Show in file manager',
  signing: 'Open guide ↗',
  signingNote: 'Signing is separate. No Apple ID is accessed. Copy 18 .data archives separately to your device.',
  logs: 'Job logs (Local · Redacted)',
  back: 'Back',
  next: 'Continue →',
  footer: 'Originals untouched. Transparent process. Verifiable result.',
  preview: 'Unsigned preview · Game builds not tested with physical game on physical phone',
  upstream: 'Upstream project ↗'
};
const titles = { zh: ['下一站，你的设备。', '你的文件，只在本机。', '先确认，再向前。', '从准备，到可验证的结果。'], en: ['Next stop, your device.', 'Your files stay with you.', 'Check first. Then move forward.', 'From preparation to a verifiable result.'] };
const subtitles = { zh: ['选择准备目标，让后面的每一步都有据可依。', '选取正确版本的 ExeFS 与 RomFS，不改动原件。', '自动准备隔离环境，逐项报告缺失或不兼容。', '真实执行上游工具，只有产物通过检查才报告完成。'], en: ['Choose a target backed by pinned source and a clean shell.', 'Choose the correct ExeFS and RomFS. Originals remain untouched.', 'Prepare an isolated environment and inspect every dependency.', 'Execute upstream tools. Only verified output is reported as complete.'] };
const stageNames = {
  starting: ['启动任务', 'Starting'],
  environment: ['准备环境', 'Preparing environment'],
  'inspect-environment': ['检查环境', 'Inspecting environment'],
  'validating-files': ['验证自有文件', 'Validating owned files'],
  'download-source': ['下载固定源码', 'Downloading pinned source'],
  'download-shell': ['下载干净壳', 'Downloading clean shell'],
  'extract-source': ['安全解压源码', 'Extracting source safely'],
  'validate-shell': ['验证壳合约', 'Verifying shell contract'],
  'copy-input': ['隔离复制文件', 'Copying private inputs'],
  'astc-encode': ['CPU 贴图转码 (astcenc thorough)', 'Encoding ASTC textures (thorough)'],
  'casc-pack': ['打包 ASTC 补充数据档', 'Packing CASC archive'],
  'astc-finalize': ['收尾生成贴图包元数据', 'Finalizing texture pack'],
  'android-pack': ['执行 Android 打包流水线', 'Running Android import pipeline'],
  pack: ['执行上游打包器', 'Running upstream packer'],
  'verify-output': ['验证产物', 'Verifying output'],
  publish: ['发布产物', 'Publishing artifact'],
  complete: ['准备完成', 'Complete'],
  preflight: ['检查完成', 'Preflight complete']
};
let language = typeof navigator !== 'undefined' && navigator.language && !/^zh/i.test(navigator.language) ? 'en' : 'zh';
let step = 0;
let bootstrap = null;
let input = null;
let output = null;
let job = { status: 'idle' };
let ready = false;
let requesting = false;
const logLines = [];
const text = (zh, en) => language === 'zh' ? zh : en;
const busy = () => requesting || job.status === 'running';
const enabledTarget = () => bootstrap?.matrix.targets.some(target => target.id === elements('target').value && target.enabled);

function notice(message, error = false) {
  elements('notice').textContent = message;
  elements('notice').hidden = !message;
  elements('notice').classList.toggle('error', error);
}

async function invoke(method, payload = {}) {
  const response = await window.prep.invoke(method, payload);
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.value;
}

function render() {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = (language === 'zh' ? chinese : english)[element.dataset.i18n] || chinese[element.dataset.i18n]; });
  elements('page-title').textContent = titles[language][step];
  elements('page-subtitle').textContent = subtitles[language][step];
  elements('crumb-step').textContent = (language === 'zh' ? chinese : english)[`step${step}`];
  document.querySelectorAll('[data-step]').forEach(element => { element.classList.toggle('active', Number(element.dataset.step) === step); element.disabled = busy(); });
  for (let index = 0; index < 4; index += 1) elements(`panel-${index}`).hidden = index !== step;

  const currentTarget = elements('target').value;
  const isIpa = ['ios26', 'ios18'].includes(currentTarget);
  const deviceField = elements('device-field');
  if (deviceField) deviceField.hidden = !isIpa;

  const deviceVal = elements('device').value;
  const deviceValid = !isIpa || ['current', 'legacy'].includes(deviceVal);

  if (!isIpa) {
    if (currentTarget === 'legacy-pack') {
      elements('device-note').textContent = text(
        '输出匹配上游 astcenc 5.2.0 thorough 的 Legacy Device Pack 文件夹，适配 jiayx v2.3.0 预编译 IPA。',
        'Generates Legacy Device Pack folder matching upstream astcenc 5.2.0 thorough for pairing with jiayx v2.3.0 IPAs.'
      );
    } else if (currentTarget === 'android') {
      elements('device-note').textContent = text(
        '输出适配 D2RMobile-android.apk v2.3.0 的 android/ 导入文件夹，免 Root 导入。',
        'Generates ready-to-copy android/ folder for D2RMobile-android.apk v2.3.0.'
      );
    }
  } else {
    if (deviceVal === 'current') {
      elements('device-note').textContent = text(
        '标准 BC 贴图路线（A17 Pro / M1+），生成单独 IPA 文件。',
        'Standard BC-texture route (A17 Pro / M1+). Outputs a standalone IPA.'
      );
    } else if (deviceVal === 'legacy') {
      elements('device-note').textContent = text(
        '为 A14–A16 设备自动生成 ASTC 覆盖层 IPA 并打包配对的 Legacy Device Pack 文件夹。',
        'Auto-generates ASTC overlay IPA paired with ready-to-copy Legacy Device Pack folder for A14–A16 devices.'
      );
    } else {
      elements('device-note').textContent = text(
        'iPhone 13 4GB、A12Z 及部分低内存设备因硬件内存限制不被支持。',
        'iPhone 13 4GB, A12Z, and low-memory devices are not supported.'
      );
    }
  }

  elements('back').disabled = busy() || step === 0;
  elements('next').hidden = step === 3;
  elements('next').disabled = busy() || (step === 0 && (!output || !enabledTarget() || !deviceValid)) || (step === 1 && !input) || (step === 2 && !ready);
  ['choose-input', 'choose-output', 'target', 'device', 'env-consent', 'build-consent'].forEach(id => { if (elements(id)) elements(id).disabled = busy(); });
  elements('check').disabled = busy() || !input || !output;
  elements('prepare-environment').disabled = busy() || !enabledTarget() || !elements('env-consent').checked;
  elements('prepare').disabled = busy() || !ready || !enabledTarget() || !deviceValid || !elements('build-consent').checked;
  elements('cancel').disabled = job.status !== 'running';
  elements('export-log').disabled = busy() || job.status === 'idle';
  elements('input-path').textContent = input?.path || text('尚未选择', 'Not selected');
  elements('output-path').textContent = output?.path || text('尚未选择', 'Not selected');
  if (bootstrap) {
    elements('host-pill').textContent = `${bootstrap.platform} · ${bootstrap.arch}`;
    elements('cache-path').textContent = `${text('应用缓存', 'App cache')}: ${bootstrap.cache}`;
    elements('mac-reason').textContent = text('原生 Mac 构建未纳入 v0.2；Apple silicon + Xcode 请使用上游脚本。Windows 无法编译原生 Mac 游戏。', bootstrap.matrix.nativeMac.reason);
    elements('target').querySelectorAll('option').forEach(option => { option.disabled = !bootstrap.matrix.targets.some(target => target.id === option.value && target.enabled); });
  }
  const stage = stageNames[job.stage];
  elements('job-status').textContent = `${stage ? stage[language === 'zh' ? 0 : 1] : text('尚未开始', 'Not started')} · ${job.status}`;
  const completed = job.completed ?? job.bytes;
  if (job.status === 'running' && !(Number.isFinite(completed) && job.total > 0)) elements('progress').removeAttribute('value');
  else { elements('progress').max = job.total || 1; elements('progress').value = completed || (job.status === 'succeeded' ? 1 : 0); }
  elements('job-count').textContent = Number.isFinite(completed) && job.total > 0 ? `${completed.toLocaleString()} / ${job.total.toLocaleString()}` : '';
  elements('job-detail').textContent = job.recoveryPath ? `${job.message}\n${text('已保留验证后的产物，请从此路径手动复制：', 'Verified artifact retained; copy it manually from:')} ${job.recoveryPath}` : job.message || job.name || text('进度来自真实阶段事件，不提供虚构倒计时。', 'Real stage events only. No invented countdown.');
  const hasResult = job.kind === 'prepare' && job.status === 'succeeded' && job.result?.path && job.result?.sha256;
  elements('result').hidden = !hasResult;
  if (hasResult) {
    const res = job.result;
    elements('result-path').textContent = res.bundlePath || res.path || '';
    elements('result-hash').textContent = res.sha256 || '';

    const resultAction = elements('result-action');
    const resultGuidance = elements('result-guidance');
    const resultTitle = elements('result-title');

    if (res.target === 'android' || (res.artifactKind === 'directory' && String(res.path).includes('android'))) {
      if (resultTitle) resultTitle.textContent = text('Android 导入包已生成', 'Android import folder generated.');
      if (resultGuidance) resultGuidance.textContent = text(
        '请将 android 文件夹与自备的 Switch RomFS/data 文件夹（含 .build.config 及 18 个 .data 文件）拷贝到手机 Download/S2X/D2R Mobile/ 目录下，随后打开 D2RMobile-android.apk 即可自动导入。',
        'Copy the android folder and your RomFS/data folder (with .build.config and all 18 .data files) to Download/S2X/D2R Mobile/ on your phone, then open D2RMobile-android.apk.'
      );
      if (resultAction) {
        resultAction.textContent = text('打开 Android 导入说明 ↗', 'Open Android Guide ↗');
        resultAction.dataset.help = 'androidSetup';
      }
    } else if (res.artifactKind === 'bundle') {
      if (resultTitle) resultTitle.textContent = text('Legacy Device 组合包已生成', 'Legacy Device Bundle generated.');
      if (resultGuidance) resultGuidance.textContent = text(
        '包含 ASTC 覆盖层 IPA 与配对的 Legacy Device Pack 文件夹。IPA 请单独签名安装，Legacy Device Pack 文件夹拷入手机 App 文档目录，并拷贝 18 个 Switch .data 资源。',
        'Includes ASTC overlay IPA paired with Legacy Device Pack folder. Sign the IPA separately, copy the Legacy Device Pack folder to phone App Documents, and copy 18 .data files.'
      );
      if (resultAction) {
        resultAction.textContent = text('打开签名说明 ↗', 'Open Signing Guide ↗');
        resultAction.dataset.help = 'signing';
      }
    } else if (res.target === 'legacy-pack') {
      if (resultTitle) resultTitle.textContent = text('Legacy Device Pack 已生成', 'Legacy Device Pack generated.');
      if (resultGuidance) resultGuidance.textContent = text(
        '请将 Legacy Device Pack 文件夹拷贝至 iPhone / iPad 上的 App 文档目录，并配对社区预编译 jiayx v2.3.0 IPA 与自备的 18 个 .data 资源。',
        'Copy the Legacy Device Pack folder to your phone App Documents directory and pair with jiayx v2.3.0 IPA and owned 18 .data archives.'
      );
      if (resultAction) {
        resultAction.textContent = text('查看 Legacy 贴图说明 ↗', 'View Legacy Guide ↗');
        resultAction.dataset.help = 'legacyDevices';
      }
    } else {
      if (resultTitle) resultTitle.textContent = text('IPA 已验证，等待签名。', 'IPA verified, waiting for signature.');
      if (resultGuidance) resultGuidance.textContent = text(
        '签名独立进行。本助手不读取 Apple ID，不承诺免费永久证书。首次启动编译着色器。还需将自有的 18 个 .data 资源档案单独拷进手机 App 的文件夹；IPA 不包含这些完整档案。',
        'Signing is separate. No Apple ID is accessed. First launch compiles shaders. Copy owned 18 .data archives to phone separately.'
      );
      if (resultAction) {
        resultAction.textContent = text('打开 Sideloadly 官方网站 ↗', 'Open Signing Guide ↗');
        resultAction.dataset.help = 'signing';
      }
    }
  }
}

function showDependencies(dependencies = []) {
  elements('dependencies').replaceChildren();
  for (const dependency of dependencies) {
    const row = document.createElement('div'); row.className = 'dependency';
    const name = document.createElement('div'); name.textContent = dependency.id;
    const status = document.createElement('span'); status.className = `dependency-state ${dependency.state}`; status.textContent = dependency.state; name.append(status);
    const detail = document.createElement('div'); detail.className = 'dependency-detail'; detail.textContent = dependency.detail;
    row.append(name, detail);
    if (dependency.help) { const help = document.createElement('button'); help.className = 'text-link'; help.textContent = text('官方说明 ↗', 'Official help ↗'); help.addEventListener('click', () => safely(() => invoke('openHelp', { id: dependency.help }))); row.append(help); }
    elements('dependencies').append(row);
  }
}

function receive(event) {
  if (event.type === 'log') {
    logLines.push(event.line); if (logLines.length > 250) logLines.shift();
    elements('logs').textContent = logLines.join('\n');
    return;
  }
  if (event.type !== 'state') return;
  job = event;
  if (event.status === 'running') step = 3;
  if (event.status !== 'running') {
    if (event.kind === 'preflight') {
      ready = event.result?.ready === true;
      const problems = event.result?.problems || [];
      elements('preflight-summary').textContent = ready ? text('检查通过：所需依赖与输入校验均已就绪。', 'Ready: required dependencies and input checks passed.') : problems.map(problem => `${problem.code}: ${problem.message}`).join('\n') || event.message || event.status;
    }
    if (event.result?.dependencies) showDependencies(event.result.dependencies);
    if (event.status === 'failed' || event.status === 'blocked') notice(event.message || text('检查尚未通过，请查看依赖和输入报告。', 'Checks are not ready. Review dependencies and input report.'), true);
    else if (event.status === 'cancelled') notice(text('已取消；原始文件不变。', 'Cancelled; originals are untouched.'));
    else notice(event.cleanupWarning || '');
  }
  render();
}

async function safely(action) {
  try { await action(); } catch (error) { notice(error.message, true); }
}

async function start(kind) {
  if (busy()) return;
  requesting = true; ready = kind === 'prepare' ? ready : false; notice(''); render();
  try {
    const payload = { kind, target: elements('target').value, inputToken: input?.token || null, outputToken: output?.token || null, consent: elements(kind === 'environment' ? 'env-consent' : 'build-consent').checked };
    if (elements('device').value !== 'current') payload.device = elements('device').value;
    await invoke('startJob', payload);
  } finally { requesting = false; render(); }
}

document.querySelectorAll('[data-step]').forEach(element => element.addEventListener('click', () => { if (!busy()) { step = Number(element.dataset.step); render(); } }));
document.querySelectorAll('[data-help]').forEach(element => element.addEventListener('click', () => safely(() => invoke('openHelp', { id: element.dataset.help }))));
elements('language').addEventListener('click', () => { language = language === 'zh' ? 'en' : 'zh'; if (job.result?.dependencies) showDependencies(job.result.dependencies); render(); });
elements('back').addEventListener('click', () => { step = Math.max(0, step - 1); render(); });
elements('next').addEventListener('click', () => { step = Math.min(3, step + 1); render(); });
for (const kind of ['input', 'output']) elements(`choose-${kind}`).addEventListener('click', () => safely(async () => {
  if (busy()) return;
  requesting = true; render();
  try { const selected = await invoke('chooseFolder', { kind }); if (selected) { if (kind === 'input') input = selected; else output = selected; ready = false; } }
  finally { requesting = false; render(); }
}));
for (const id of ['target', 'device']) elements(id).addEventListener('change', () => { ready = false; elements('result').hidden = true; render(); });
for (const id of ['env-consent', 'build-consent']) elements(id).addEventListener('change', render);
elements('check').addEventListener('click', () => safely(() => start('preflight')));
elements('prepare-environment').addEventListener('click', () => safely(() => start('environment')));
elements('prepare').addEventListener('click', () => safely(() => start('prepare')));
elements('cancel').addEventListener('click', () => safely(() => invoke('cancel')));
elements('export-log').addEventListener('click', () => safely(() => invoke('exportLog')));
elements('reveal').addEventListener('click', () => safely(() => invoke('revealResult')));
window.prep.subscribe(receive);
safely(async () => {
  bootstrap = await invoke('bootstrap');
  job = bootstrap.state;
  if (job.status === 'running') step = 3;
  if (!bootstrap.matrix.hostSupported) notice(text('请使用 Windows x64 或 macOS。', 'Use Windows x64 or macOS.'), true);
  render();
});
render();
