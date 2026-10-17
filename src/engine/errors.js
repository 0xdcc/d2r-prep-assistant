'use strict';

class PrepError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrepError';
    this.code = code;
  }
}

function assert(condition, code, message) {
  if (!condition) throw new PrepError(code, message);
}

module.exports = { PrepError, assert };
