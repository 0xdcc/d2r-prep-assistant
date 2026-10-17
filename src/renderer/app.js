'use strict';

const elements = id => document.getElementById(id);
const chinese = {};
document.querySelectorAll('[data-i18n]').forEach(element => { chinese[element.dataset.i18n] = element.textContent; });
const english = {
  workspace: 'PREPARATION WORKSPACE', step0: 'Device & output', step0sub: 'Choose your destination', step1: 'Your game files', step1sub: 'Always on your computer', step2: 'Environment check', step2sub: 'Verify before preparing', step3: 'Prepare & result', step3sub: 'A traceable local job',
  local: 'Local processing · No uploads', localSub: 'No account. No cloud game files. Saves are never processed.', eyebrow: 'YOUR FILES. YOUR DEVICE.', destination: 'What are we preparing?', outputs: 'OUTPUT TYPE', firstRelease: 'FIRST RELEASE', ipaDesc: 'Prepare an IPA from your own files. Sign and install separately.', notAvailable: 'NOT AVAILABLE', nativeMac: 'Native Mac app', systemTarget: 'iOS target', targetNote: 'Pinned v1.0.17 source and matching clean shell. No community game-derived IPA.', deviceLabel: 'Device compatibility reference', currentDevice: 'Newer BC-texture-capable device · check upstream compatibility', legacyDevice: 'A14–A16 · ≥6GB (Legacy workflow not implemented here)', unsupportedDevice: 'iPhone 13 4GB / A12Z · unsupported', outputFolder: 'Output folder', notSelected: 'Not selected', chooseFolder: 'Choose folder', noOverwrite: 'Each job creates a unique name. Existing IPAs are never overwritten. Preparation is not signing.', ownFiles: 'Use your own game files', ownNotice: 'Local files only. No game downloads or save processing.', inputFolder: 'Parent folder of ExeFS + RomFS', requiredLayout: 'Required folder structure', layoutNote: 'NSP, XCI, download links and prebuilt IPAs are not accepted.', strictVersion: 'Exact version, not an ownership checkbox', versionInfo: 'Switch 1.0.34.0 / internal 3.3.94012 + expansion. Three upstream program SHA-256 checks; 18 nonempty resource archives and PSV extents. No full resource hashes are published: resources are NOT cryptographically verified.', privateCopy: 'Only needed files are privately copied. Upstream never receives the original folder. Links and overlapping paths are rejected.', preflightTitle: 'Before starting, check the essentials.', runCheck: 'Run check', checkIntro: 'Check dependencies, actual input version, path safety and disk space. The no-Metal IPA route does not require Xcode; the phone compiles shaders at first launch.', prepareEnv: 'Prepare isolated environment', envNote: 'Prepare app-owned Python 3.12, five hash-pinned wheels and .NET 10. Windows uses portable LLVM-MinGW if needed. Build pinned SPIRV-Cross with CMake/Ninja, at most two threads. macOS needs Apple Command Line Tools installed separately. No global installation.', envConsent: 'Allow pinned publisher tools and PyPI wheels (~0.8–1 GB), and local SPIRV-Cross compilation', prepareEnvButton: 'Prepare environment', readyTitle: 'A process you can inspect.', runIntro: 'Pinned source & shell → isolated copy → upstream packer (first .NET build may restore NuGet dependencies online) → pack_info, shell manifest, executable and CRC checks → SHA-256 → unique IPA.', buildConsent: 'Allow pinned source, clean shell and upstream .NET NuGet dependencies. No game content is downloaded.', startPrepare: 'Start local preparation ↗', cancel: 'Cancel job', exportLog: 'Export redacted log', idle: 'Not started', realProgress: 'Real stage events only. No invented countdown.', verifiedResult: 'IPA verified. Sign separately.', showFile: 'Show in file manager', signing: 'Open official Sideloadly website ↗', signingNote: 'No Apple ID access or promise of permanent free certificates. Shaders compile at first launch. Copy your own 18 .data resource archives separately into the phone app folder; these full archives are not in the IPA.', logs: 'Job log (local · redacted)', footer: 'Originals untouched. Transparent process. Verifiable result.', back: 'Back', next: 'Continue →', preview: 'Unsigned preview · game build not tested with actual owned files', upstream: 'Upstream project ↗'
};
const titles = { zh: ['下一站，你的设备。', '你的文件，只在本机。', '先确认，再向前。', '从准备，到可验证的结果。'], en: ['Next stop, your device.', 'Your files stay with you.', 'Check first. Then move forward.', 'From preparation to a verifiable result.'] };
const subtitles = { zh: ['选择准备目标，让后面的每一步都有据可依。', '选取正确版本的 ExeFS 与 RomFS，不改动原件。', '自动准备隔离环境，逐项报告缺失或不兼容。', '真实执行上游工具，只有产物通过检查才报告完成。'], en: ['Choose a target backed by pinned source and a clean shell.', 'Choose the correct ExeFS and RomFS. Originals remain untouched.', 'Prepare an isolated environment and inspect every dependency.', 'Execute upstream tools. Only verified output is reported as complete.'] };
const stageNames = { starting: ['启动任务', 'Starting'], environment: ['准备环境', 'Preparing environment'], 'inspect-environment': ['检查环境', 'Inspecting environment'], 'validating-files': ['验证自有文件', 'Validating owned files'], 'download-source': ['下载固定源码', 'Downloading pinned source'], 'download-shell': ['下载干净壳', 'Downloading clean shell'], 'extract-source': ['安全解压源码', 'Extracting source safely'], 'validate-shell': ['验证壳合约', 'Verifying shell contract'], 'copy-input': ['隔离复制文件', 'Copying private inputs'], pack: ['执行上游打包器', 'Running upstream packer'], 'verify-output': ['验证产物', 'Verifying output'], publish: ['发布唯一文件', 'Publishing unique file'], complete: ['准备完成', 'Complete'], preflight: ['检查完成', 'Preflight complete'] };
let language = 'zh';
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
  elements('back').disabled = busy() || step === 0;
  elements('next').hidden = step === 3;
  elements('next').disabled = busy() || (step === 0 && (!output || !enabledTarget() || elements('device').value !== 'current')) || (step === 1 && !input) || (step === 2 && !ready);
  ['choose-input', 'choose-output', 'target', 'device', 'env-consent', 'build-consent'].forEach(id => { elements(id).disabled = busy(); });
  elements('check').disabled = busy() || !input || !output;
  elements('prepare-environment').disabled = busy() || !enabledTarget() || !elements('env-consent').checked;
  elements('prepare').disabled = busy() || !ready || !enabledTarget() || elements('device').value !== 'current' || !elements('build-consent').checked;
  elements('cancel').disabled = job.status !== 'running';
  elements('export-log').disabled = busy() || job.status === 'idle';
  elements('input-path').textContent = input?.path || text('尚未选择', 'Not selected');
  elements('output-path').textContent = output?.path || text('尚未选择', 'Not selected');
  elements('device-note').textContent = elements('device').value === 'current' ? text('本版仅提供标准 BC 贴图路线；设备兼容性请查上游说明。', 'Standard BC-texture route only. Check the upstream device requirements.') : text('此选择不能开始准备。本版不生成 Legacy 贴图包，不支持低内存设备。', 'Preparation is unavailable for this selection. Legacy texture packs and low-memory devices are not supported here.');
  if (bootstrap) {
    elements('host-pill').textContent = `${bootstrap.platform} · ${bootstrap.arch}`;
    elements('cache-path').textContent = `${text('应用缓存', 'App cache')}: ${bootstrap.cache}`;
    elements('mac-reason').textContent = text('原生 Mac 构建未纳入 v0.1；Apple silicon + Xcode 请使用上游脚本。Windows 无法编译原生 Mac 游戏。', bootstrap.matrix.nativeMac.reason);
    elements('target').querySelectorAll('option').forEach(option => { option.disabled = !bootstrap.matrix.targets.some(target => target.id === option.value && target.enabled); });
  }
  const stage = stageNames[job.stage];
  elements('job-status').textContent = `${stage ? stage[language === 'zh' ? 0 : 1] : text('尚未开始', 'Not started')} · ${job.status}`;
  const completed = job.completed ?? job.bytes;
  if (job.status === 'running' && !(Number.isFinite(completed) && job.total > 0)) elements('progress').removeAttribute('value');
  else { elements('progress').max = job.total || 1; elements('progress').value = completed || (job.status === 'succeeded' ? 1 : 0); }
  elements('job-count').textContent = Number.isFinite(completed) && job.total > 0 ? `${completed.toLocaleString()} / ${job.total.toLocaleString()}` : '';
  elements('job-detail').textContent = job.recoveryPath ? `${job.message}\n${text('已保留验证后的 IPA，请从此路径手动复制：', 'Verified IPA retained; copy it manually from:')} ${job.recoveryPath}` : job.message || job.name || text('进度来自真实阶段事件，不提供虚构倒计时。', 'Real stage events only. No invented countdown.');
  elements('result').hidden = !(job.kind === 'prepare' && job.status === 'succeeded' && job.result?.path && job.result?.sha256);
  elements('result-path').textContent = job.result?.path || '';
  elements('result-hash').textContent = job.result?.sha256 || '';
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
      elements('preflight-summary').textContent = ready ? text('检查通过：三个程序哈希匹配；资源仅检查存在、非空与清单范围（不是完整资源密码学验证）。', 'Ready: three program hashes matched. Resource presence/nonzero/manifest extents checked, NOT full resource cryptographic verification.') : problems.map(problem => `${problem.code}: ${problem.message}`).join('\n') || event.message || event.status;
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
    await invoke('startJob', { kind, target: elements('target').value, inputToken: input?.token || null, outputToken: output?.token || null, consent: elements(kind === 'environment' ? 'env-consent' : 'build-consent').checked });
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
