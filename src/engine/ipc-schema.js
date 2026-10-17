'use strict';

const { assert } = require('./errors');

const HELP_IDS = ['signing', 'python', 'dotnet', 'llvm', 'spirv', 'upstream', 'xcode'];
const METHODS = {
  bootstrap: {},
  chooseFolder: { kind: value => ['input', 'output'].includes(value) },
  startJob: {
    kind: value => ['preflight', 'environment', 'prepare'].includes(value),
    target: value => ['ios18', 'ios26'].includes(value),
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
  assert(Object.keys(payload).length === Object.keys(schema).length && Object.keys(payload).every(key => Object.hasOwn(schema, key)), 'IPC_FIELDS', 'Unexpected or missing IPC fields.');
  for (const [key, validate] of Object.entries(schema)) assert(validate(payload[key]), 'IPC_FIELD', `Invalid IPC field: ${key}`);
  return payload;
}

module.exports = { validateRequest, HELP_IDS };
