import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
const { createBrowserTestCall, claimBrowserTestCall, reapBrowserTestCalls } = await import('../src/voice/browser-test.service.js');
const { encodeMuLawSample } = await import('../src/voice/audio/codec.js');
const { BrowserCallRecorder, createBrowserRecordingWav } = await import('../src/voice/browser-call-recording.service.js');
const auth = { tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a' };
let inserts = [];
let released = 0;
let acquired = 0;
let direction = 'both';
const dependencies = {
  contextRunner: async (actor, operation) => {
    assert.equal(actor, auth);
    return operation({ query: async (_sql, values) => {
      assert.deepEqual(values, ['agent-a', auth.tenantId, auth.workspaceId]);
      return { rowCount: 1, rows: [{ usage_direction: direction, concurrency_limit: 3 }] };
    } });
  },
  writeContext: async (operation) => operation({ query: async (_sql, values) => { inserts.push(values); return { rowCount: 1 }; } }),
  loadProfile: async (resolved) => {
    assert.equal(resolved.tenantId, auth.tenantId);
    assert.equal(resolved.workspaceId, auth.workspaceId);
    assert.equal(resolved.callDirection, direction === 'outbound' ? 'outbound' : 'inbound');
    return { agent: { name: 'Test agent' } };
  },
  preflight: () => {},
  createToken: () => 'signed-token',
  ownership: {
    acquire: async (input) => { acquired++; assert.equal(input.limit, 3); },
    release: async () => { released++; },
  },
};
const call = await createBrowserTestCall(auth, 'agent-a', dependencies);
assert.match(call.mediaPath, /^\/webhooks\/plivo\/media\?call_id=.*&token=signed-token$/);
assert.match(inserts[0][6], /^\+[1-9][0-9]{6,14}$/);
assert.equal(inserts[0][7], 'inbound');
assert.equal(JSON.parse(inserts[0][8]).source, 'browser-test');
assert.equal(JSON.parse(inserts[0][8]).createdBy, auth.userId);
direction = 'outbound';
await createBrowserTestCall(auth, 'agent-a', dependencies);
assert.equal(inserts[1][7], 'outbound');
await assert.rejects(createBrowserTestCall(auth, 'agent-a', { ...dependencies,
  contextRunner: async (_auth, operation) => operation({ query: async () => ({ rowCount: 0 }) }),
}), { code: 'AGENT_NOT_FOUND' });
assert.equal(acquired, 2, 'Missing/cross-tenant agents must not reserve capacity');
await assert.rejects(createBrowserTestCall(auth, 'agent-a', { ...dependencies,
  createToken: () => { throw new Error('no signing secret'); },
}), /no signing secret/);
assert.equal(acquired, 2, 'Signing failure must leave no reservation');
await assert.rejects(createBrowserTestCall(auth, 'agent-a', { ...dependencies,
  writeContext: async () => { throw new Error('insert failed'); },
}), /insert failed/);
assert.equal(released, 1, 'Insertion failure must release capacity');

let claimed = false;
const browserCall = { id: call.callId, providerMetadata: { source: 'browser-test' } };
const claimDeps = { contextRunner: async (operation) => operation({ query: async (_sql, values) => {
  assert.equal(values[0], call.callId);
  const rowCount = claimed ? 0 : 1;
  claimed = true;
  return { rowCount };
} }) };
await claimBrowserTestCall(browserCall, claimDeps);
await assert.rejects(claimBrowserTestCall(browserCall, claimDeps), { code: 'BROWSER_TEST_EXPIRED' });
await claimBrowserTestCall({ providerMetadata: { source: 'plivo-answer' } }, {
  contextRunner: () => { throw new Error('Telephone calls must not be changed'); },
});
let expiredReleased = false;
await reapBrowserTestCalls({
  contextRunner: async (operation) => operation({ query: async () => ({ rows: [{ tenant_id: 'tenant-a', provider_call_id: 'expired' }] }) }),
  ownership: { releaseValidated: async (input) => { assert.equal(input.providerCallId, 'expired'); expiredReleased = true; } },
});
assert.ok(expiredReleased);

// Execute the actual microphone worklet with browser globals, checking sample counts
// and codec agreement across render-block boundaries at common device sample rates.
const workletSource = await readFile(new URL('../../Frontend/public/browser-audio-worklet.js', import.meta.url), 'utf8');
for (const sampleRate of [8000, 44100, 48000]) {
  const frames = [];
  let Processor;
  vm.runInNewContext(workletSource, {
    sampleRate, Uint8Array,
    AudioWorkletProcessor: class { port = { postMessage: (frame) => frames.push(frame) }; },
    registerProcessor: (_name, processor) => { Processor = processor; },
  });
  const processor = new Processor();
  for (let offset = 0; offset < sampleRate; offset += 128) {
    processor.process([[new Float32Array(Math.min(128, sampleRate - offset)).fill(0.25)]]);
  }
  assert.equal(frames.length, 50, `Expected one second of 20ms frames at ${sampleRate} Hz`);
  assert.ok(frames.every((frame) => frame.length === 160 && frame.every((sample) => sample === encodeMuLawSample(8192))));
}

const wav = createBrowserRecordingWav([
  { track: 'inbound', offset: 0, audio: Buffer.alloc(160, 0xff) },
  { track: 'outbound', offset: 160, audio: Buffer.alloc(160, 0xff) },
]);
assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
assert.equal(wav.readUInt16LE(22), 2, 'Browser recordings must preserve caller and agent as stereo channels');
assert.equal(wav.readUInt32LE(24), 8000);

let recordingNow = 0;
let storedRecording;
let recordingUpdate;
const recorder = new BrowserCallRecorder({
  id: 'call-a', tenantId: auth.tenantId, workspaceId: auth.workspaceId,
}, {
  now: () => recordingNow,
  putObject: async (input) => { storedRecording = input; },
  contextRunner: async (operation) => operation({ query: async (_sql, values) => { recordingUpdate = values; } }),
});
recorder.capture('inbound', Buffer.alloc(160, 0xff));
recordingNow = 20;
recorder.capture('outbound', Buffer.alloc(160, 0xff));
const stored = await recorder.finalize();
assert.equal(stored.contentType, 'audio/wav');
assert.match(stored.key, /^recordings\/tenant-a\/workspace-a\/call-a\/browser-.+\.wav$/);
assert.equal(storedRecording.contentType, 'audio/wav');
assert.equal(storedRecording.timeoutMs, 120000, 'Long browser recordings need the recording-specific upload timeout');
assert.equal(recordingUpdate[0], 'call-a');
assert.equal(recordingUpdate[1], stored.key);
assert.equal(await recorder.finalize(), null, 'A browser recording must only be finalized once');

let uploadAttempts = 0;
const retryRecorder = new BrowserCallRecorder({
  id: 'call-retry', tenantId: auth.tenantId, workspaceId: auth.workspaceId,
}, {
  now: () => 0,
  putObject: async () => {
    uploadAttempts += 1;
    if (uploadAttempts < 3) throw new Error('temporary upload timeout');
  },
  contextRunner: async (operation) => operation({ query: async () => {} }),
});
retryRecorder.capture('inbound', Buffer.alloc(160, 0xff));
await retryRecorder.finalize();
assert.equal(uploadAttempts, 3, 'Browser recording upload must retry transient failures');

console.log('Browser test authorization, lifecycle, microphone audio, and private recording checks passed.');
