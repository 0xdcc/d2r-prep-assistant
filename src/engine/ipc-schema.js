'use strict';

const { assert } = require('./errors');

const HELP_IDS = [
  'gameFiles',
  'signing',
  'olderSystems',
  'legacyDevices',
  'androidSetup',
  'python',
  'dotnet',
  'compiler',
  'cmake',
  'spirvCross',
  'astcenc',
  'vulkanTools',
  'llvm',
  'spirv',
  'upstream',
  'xcode'
];

const METHODS = {
  bootstrap: {},
  chooseFolder: { kind: value => ['input', 'output'].includes(value) },
  startJob: {
    kind: value => ['preflight', 'environment', 'prepare'].includes(value),
    target: value => ['ios18', 'ios26', 'legacy-pack', 'android'].includes(value),
    device: value => value === undefined || ['current', 'legacy'].includes(value),
    inputToken: value => value === null || /^[a-f0-9-]{36}$/.test(value),
    outputToken: value => value === null || /^[a-f0-9-]{36}$/.test(value),
    consent: value => typeof value === 'boolean'
  },
  cancel: {},
  snapshot: {},
  exportLog: {},
  revealResult: {},
  openHelp: { id: value => HELP_IDS.includes(value) }
};

function validateRequest(method, payload) {
  assert(typeof method === 'string' && Object.hasOwn(METHODS, method), 'IPC_METHOD', 'Unknown IPC operation.');
  assert(payload && typeof payload === 'object' && !Array.isArray(payload) && Object.getPrototypeOf(payload) === Object.prototype, 'IPC_PAYLOAD', 'IPC payload must be a plain object.');
  const schema = METHODS[method];
  const payloadKeys = Object.keys(payload);
  const schemaKeys = Object.keys(schema);
  const requiredKeys = method === 'startJob' ? ['kind', 'target', 'inputToken', 'outputToken', 'consent'] : schemaKeys;
  assert(requiredKeys.every(key => Object.hasOwn(payload, key)) && payloadKeys.every(key => Object.hasOwn(schema, key)), 'IPC_FIELDS', 'Unexpected or missing IPC fields.');
  for (const [key, validate] of Object.entries(schema)) {
    if (Object.hasOwn(payload, key)) {
      assert(validate(payload[key]), 'IPC_FIELD', `Invalid IPC field: ${key}`);
    }
  }
  return payload;
}

module.exports = { validateRequest, HELP_IDS };
