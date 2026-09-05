import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startCallHeartbeat } from '../src/voice/call-heartbeat.js';

function fixture(heartbeat) {
  let time = 0;
  let nextId = 0;
  const timers = new Map();
  const logs = [];
  const session = new EventEmitter();
  Object.assign(session, {
    callId: 'call', providerCallId: 'provider-call', call: { tenantId: 'tenant' }, closed: false,
    log: Object.fromEntries(['warn', 'error', 'info'].map((level) => [level, (...args) => logs.push([level, ...args])])),
    close(code, reason) { this.closed = true; this.reason = reason; this.emit('closed'); },
  });
  startCallHeartbeat({ session, ownership: { heartbeat }, intervalMs: 15000, ttlMs: 60000,
    claimedAt: 0, now: () => time,
    schedule: (fn, delay) => { const id = ++nextId; timers.set(id, { at: time + delay, fn }); return id; },
    unschedule: (id) => timers.delete(id),
  });
  return { session, logs, timers, async advance(ms) {
    const target = time + ms;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      timers.delete(next[0]); time = next[1].at; next[1].fn();
      await Promise.resolve(); await Promise.resolve();
    }
    time = target;
  } };
}

let attempts = 0;
const recovered = fixture(async () => { if (++attempts <= 2) throw new Error('Command timed out'); return true; });
await recovered.advance(18000);
assert.equal(attempts, 3);
assert.equal(recovered.session.closed, false, 'Temporary Redis failures must not disconnect the caller');
assert.ok(recovered.logs.some(([level]) => level === 'info'));
await recovered.advance(45000);
assert.equal(recovered.session.closed, false, 'Successful renewals extend the lease');
recovered.session.close(1000, 'caller ended');
assert.equal(recovered.timers.size, 0);

const outage = fixture(async () => { throw new Error('Command timed out'); });
await outage.advance(59000);
assert.equal(outage.session.reason, 'voice call heartbeat lease expired');
assert.equal(outage.timers.size, 0);

const lost = fixture(async () => false);
await lost.advance(15000);
assert.equal(lost.session.reason, 'voice call ownership lost');

let resolvePending;
let pendingCalls = 0;
const hung = fixture(() => { pendingCalls++; return new Promise((resolve) => { resolvePending = resolve; }); });
await hung.advance(59000);
assert.equal(pendingCalls, 1, 'Heartbeat requests must never overlap');
assert.equal(hung.session.closed, true, 'A stuck Redis request must not bypass lease expiry');
resolvePending(true);
await Promise.resolve(); await Promise.resolve();
assert.equal(hung.timers.size, 0, 'Late Redis responses must not restart a closed call');

const ended = fixture(() => new Promise((resolve) => { resolvePending = resolve; }));
await ended.advance(15000);
ended.session.close(1000, 'caller ended');
resolvePending(false);
await Promise.resolve(); await Promise.resolve();
assert.equal(ended.session.reason, 'caller ended');
assert.equal(ended.timers.size, 0);
console.log('Heartbeat retry, recovery, expiry, ownership loss, and shutdown checks passed.');
