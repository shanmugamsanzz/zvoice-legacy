import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/browserTestCall.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source.replaceAll('import.meta.env.BASE_URL', "'/'"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
  const state = { requests: 0, stops: 0, closed: 0, messages: [], transcripts: [], ended: [], status: [] };
  const track = { stop() { state.stops++; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const devices = { getUserMedia: async () => stream };
  const sources = [];
  class Context {
    currentTime = 0;
    destination = {};
    audioWorklet = { addModule: async () => {} };
    async resume() {}
    async close() { state.closed++; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createBuffer(_channels, length) { return { duration: length / 8000, getChannelData: () => new Float32Array(length) }; }
    createBufferSource() {
      const source = { connect() {}, disconnect() {}, start() {}, stop() { this.stopped = true; } };
      sources.push(source);
      return source;
    }
  }
  class Processor {
    constructor() { state.processor = this; }
    port = { close() {} };
    connect() {}
    disconnect() {}
  }
  class Socket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    constructor() { state.socket = this; }
    send(value) { state.messages.push(JSON.parse(value)); }
    close(code) { this.readyState = 3; state.closeCode = code; }
    receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
  }
  const exports = {};
  vm.runInNewContext(compiled, { exports, AudioContext: Context, AudioWorkletNode: Processor,
    WebSocket: Socket, navigator: { mediaDevices: devices },
    window: { AudioContext: Context, setTimeout, clearTimeout }, Uint8Array, btoa, atob, Error,
    require: () => ({ apiWebSocketUrl: (path) => path, apiRequest: async () => {
      state.requests++;
      return { callId: 'call-a', providerCallId: 'browser-a', mediaPath: '/media', protocol: 'test' };
    } }),
  });
  const call = new exports.BrowserTestCall({
    onStatus: (status) => state.status.push(status), onCall: (id) => { state.callId = id; },
    onTranscript: (speaker, text) => state.transcripts.push({ speaker, text }), onEnded: (error) => state.ended.push(error),
  });
  return { call, state, devices, stream, sources };
}

const { call, state, sources } = fixture();
await call.start('agent-a');
assert.equal(state.requests, 1);
assert.equal(state.messages.length, 0, 'Wait for provider readiness before streaming');
state.socket.receive({ event: 'ready' });
assert.equal(state.messages[0].event, 'start');
state.processor.port.onmessage({ data: new Uint8Array(160).fill(128) });
assert.equal(atob(state.messages.at(-1).media.payload).charCodeAt(0), 128);
call.setMuted(true);
state.processor.port.onmessage({ data: new Uint8Array(160).fill(128) });
assert.equal(atob(state.messages.at(-1).media.payload).charCodeAt(0), 255, 'Muted input sends silence');
state.socket.receive({ event: 'playAudio', media: { payload: btoa(String.fromCharCode(...new Uint8Array(160).fill(255))) } });
state.socket.receive({ event: 'checkpoint', name: 'reply' });
assert.notEqual(state.messages.at(-1).event, 'playedStream', 'Do not acknowledge audio before playback');
sources.at(-1).onended();
assert.equal(state.messages.at(-1).event, 'playedStream');
state.socket.receive({ event: 'clearAudio' });
assert.ok(sources[0].stopped);
assert.equal(state.messages.at(-1).event, 'clearedAudio');
state.socket.receive({ event: 'transcript', speaker: 'agent', text: 'Hello' });
assert.equal(state.transcripts[0].text, 'Hello');
call.end(); call.end();
assert.equal(state.messages.at(-1).event, 'stop');
assert.equal(state.stops, 1);
assert.equal(state.closed, 1);
assert.equal(state.ended.length, 1);

const denied = fixture();
denied.devices.getUserMedia = async () => { throw new Error('Permission denied'); };
await denied.call.start('agent-a');
assert.equal(denied.state.requests, 0, 'Denied microphone must not create a call');
assert.equal(denied.state.ended[0], 'Permission denied');

const pending = fixture();
let grant;
pending.devices.getUserMedia = () => new Promise((resolve) => { grant = resolve; });
const starting = pending.call.start('agent-a');
await new Promise(setImmediate);
pending.call.end();
grant(pending.stream);
await starting;
assert.equal(pending.state.requests, 0);
assert.equal(pending.state.stops, 1, 'Canceling during permission request must stop subsequently granted microphone');

const failed = fixture();
await failed.call.start('agent-a');
failed.state.socket.receive({ event: 'error', message: 'Provider failed' });
assert.equal(failed.state.closeCode, 4000);
assert.equal(failed.state.messages.length, 0, 'An error must not send a successful stop event');
assert.equal(failed.state.stops, 1);
console.log('Browser connection, playback, mute, transcript, cancellation, and error cleanup checks passed.');
