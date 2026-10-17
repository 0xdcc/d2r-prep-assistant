'use strict';

function testBridge(bootstrap) {
  const calls = []; let subscriber;
  return { calls, emit: event => subscriber(event), bridge: {
    subscribe: callback => { subscriber = callback; },
    invoke: async (method, payload) => {
      calls.push({ method, payload });
      if (method === 'bootstrap') return { ok: true, value: bootstrap };
      if (method === 'chooseFolder') return { ok: true, value: { token: payload.kind === 'input' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222', path: `/synthetic/${payload.kind} 中文` } };
      return { ok: true, value: { id: 'synthetic-event-protocol-only' } };
    }
  } };
}

module.exports = { testBridge };
