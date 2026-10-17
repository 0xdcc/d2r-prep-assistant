'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { testBridge } = require('./renderer-bridge');

class Element {
  constructor(dataset = {}) { this.dataset = dataset; this.textContent = ''; this.value = ''; this.checked = false; this.hidden = false; this.disabled = false; this.listeners = {}; this.children = []; this.classList = { toggle: () => {} }; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  async click() { if (!this.disabled) { await this.listeners.click?.(); await new Promise(resolve => setImmediate(resolve)); } }
  append(...children) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  removeAttribute(name) { delete this[name]; }
  querySelectorAll() { return []; }
}

async function setup() {
  const html = fs.readFileSync(path.resolve(__dirname, '../src/renderer/index.html'), 'utf8');
  const ids = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  ids.get('target').value = 'ios26'; ids.get('device').value = 'current';
  const translations = [...html.matchAll(/data-i18n="([^"]+)"[^>]*>([^<]*)/g)].map(match => { const element = new Element({ i18n: match[1] }); element.textContent = match[2]; return element; });
  const steps = [0, 1, 2, 3].map(index => new Element({ step: String(index) }));
  const document = { documentElement: {}, getElementById: id => { assert(ids.has(id), `unknown HTML ID ${id}`); return ids.get(id); }, querySelectorAll: selector => selector === '[data-i18n]' ? translations : selector === '[data-step]' ? steps : [], createElement: () => new Element() };
  const bridge = testBridge({ platform: 'win32', arch: 'x64', cache: '/synthetic/cache', matrix: { hostSupported: true, targets: [{ id: 'ios18', enabled: true }, { id: 'ios26', enabled: true }], nativeMac: { reason: 'not in v0.1' } }, state: { status: 'idle' } });
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/renderer/app.js'), 'utf8'), { window: { prep: bridge.bridge }, document, console });
  await new Promise(resolve => setImmediate(resolve));
  return { ids, bridge, document, steps };
}

test('production wizard initializes in Chinese and switches to English using injected test-only bridge', async () => {
  const { ids, document } = await setup();
  assert.equal(document.documentElement.lang, 'zh-CN');
  assert.equal(ids.get('next').disabled, true);
  await ids.get('language').click();
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(ids.get('page-title').textContent, 'Next stop, your device.');
});

test('wizard selects native-picker tokens, invokes actual preflight IPC shape, never passes commands', async () => {
  const { ids, bridge } = await setup();
  await ids.get('choose-output').click(); await ids.get('choose-input').click();
  assert.equal(ids.get('check').disabled, false);
  await ids.get('check').click();
  const call = bridge.calls.find(item => item.method === 'startJob');
  assert.equal(call.payload.kind, 'preflight');
  assert.equal(call.payload.inputToken, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(Object.keys(call.payload).sort(), ['consent', 'inputToken', 'kind', 'outputToken', 'target']);
});

test('real state events control progress and success; missing output never displays success', async () => {
  const { ids, bridge, steps } = await setup();
  bridge.emit({ type: 'state', kind: 'prepare', status: 'running', stage: 'pack' });
  assert.equal(ids.get('cancel').disabled, false);
  assert.equal(steps[0].disabled, true);
  assert.equal(ids.get('result').hidden, true);
  bridge.emit({ type: 'state', kind: 'prepare', status: 'succeeded', stage: 'complete', result: {} });
  assert.equal(ids.get('result').hidden, true);
  bridge.emit({ type: 'state', kind: 'prepare', status: 'failed', message: 'protocol fixture rejection' });
  assert.equal(ids.get('notice').textContent, 'protocol fixture rejection');
  assert.equal(ids.get('result').hidden, true);
  for (let index = 0; index < 260; index += 1) bridge.emit({ type: 'log', line: `synthetic protocol line ${index}` });
  assert.equal(ids.get('logs').textContent.split('\n').length, 250);
});

test('environment and preflight running jobs expose visible, usable cancel controls', async () => {
  const { ids, bridge } = await setup();
  for (const kind of ['environment', 'preflight']) {
    bridge.emit({ type: 'state', kind, status: 'running', stage: 'environment' });
    assert.equal(ids.get('panel-3').hidden, false);
    assert.equal(ids.get('cancel').disabled, false);
    await ids.get('cancel').click();
    assert.equal(bridge.calls.at(-1).method, 'cancel');
    bridge.emit({ type: 'state', kind, status: 'cancelled' });
    assert.equal(ids.get('back').disabled, false);
  }
  bridge.emit({ type: 'state', kind: 'prepare', status: 'failed', message: 'publication failed', recoveryPath: '/synthetic/job/prepared.ipa' });
  assert.match(ids.get('job-detail').textContent, /\/synthetic\/job\/prepared\.ipa/);
  assert.equal(ids.get('result').hidden, true);
});
