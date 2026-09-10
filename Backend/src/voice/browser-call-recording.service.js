import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { withAuthServiceContext } from '../infrastructure/database-context.js';
import { putB2Object } from '../rag/b2.client.js';
import { decodeMuLawSample } from './audio/codec.js';

const sampleRate = 8000;
const channelCount = 2;
const bytesPerSample = 2;
const wavHeaderBytes = 44;

function wavHeader(sampleCount) {
  const dataBytes = sampleCount * channelCount * bytesPerSample;
  const header = Buffer.alloc(wavHeaderBytes);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channelCount, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
  header.writeUInt16LE(channelCount * bytesPerSample, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

export function createBrowserRecordingWav(chunks) {
  const sampleCount = chunks.reduce((maximum, chunk) => Math.max(maximum, chunk.offset + chunk.audio.length), 0);
  if (!sampleCount) return null;
  const body = Buffer.alloc(wavHeaderBytes + sampleCount * channelCount * bytesPerSample);
  wavHeader(sampleCount).copy(body);
  for (const chunk of chunks) {
    const channel = chunk.track === 'outbound' ? 1 : 0;
    for (let index = 0; index < chunk.audio.length; index += 1) {
      const target = wavHeaderBytes + ((chunk.offset + index) * channelCount + channel) * bytesPerSample;
      body.writeInt16LE(decodeMuLawSample(chunk.audio[index]), target);
    }
  }
  return body;
}

async function storeBrowserRecording(call, body, durationMs, dependencies) {
  const recordingId = 'browser-' + crypto.randomUUID();
  const key = ['recordings', call.tenantId, call.workspaceId, call.id, recordingId + '.wav'].join('/');
  const checksumSha256 = crypto.createHash('sha256').update(body).digest('hex');
  const contextRunner = dependencies.contextRunner ?? withAuthServiceContext;
  const recordingMetadata = {
    id: recordingId, status: 'processing', source: 'browser-test', durationMs,
    contentType: 'audio/wav', sizeBytes: body.length, checksumSha256,
  };
  await contextRunner((client) => client.query(`UPDATE call_sessions SET
    provider_metadata=jsonb_set(COALESCE(provider_metadata,'{}'::jsonb),'{recording}',$2::jsonb,true)
    WHERE id=$1`, [call.id, JSON.stringify(recordingMetadata)]));
  const putObject = dependencies.putObject ?? putB2Object;
  let uploadError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await putObject({
        key, body, contentType: 'audio/wav', timeoutMs: env.VOICE_RECORDING_DOWNLOAD_TIMEOUT_MS,
        metadata: {
          tenantId: call.tenantId, workspaceId: call.workspaceId, callId: call.id,
          recordingId, checksumSha256, source: 'browser-test',
        },
      });
      uploadError = null;
      break;
    } catch (error) {
      uploadError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  if (uploadError) {
    await contextRunner((client) => client.query(`UPDATE call_sessions SET
      provider_metadata=jsonb_set(jsonb_set(COALESCE(provider_metadata,'{}'::jsonb),
        '{recording,status}','"failed"'::jsonb,true),'{recording,error}',$2::jsonb,true)
      WHERE id=$1`, [call.id, JSON.stringify(String(uploadError.message ?? uploadError).slice(0, 500))])).catch(() => {});
    throw uploadError;
  }
  await contextRunner((client) => client.query(`UPDATE call_sessions SET
      recording_object_key=$2,
      provider_metadata=jsonb_set(COALESCE(provider_metadata,'{}'::jsonb),'{recording}',$3::jsonb,true)
    WHERE id=$1`, [call.id, key, JSON.stringify({
    ...recordingMetadata, status: 'stored',
    storedAt: new Date().toISOString(),
  })]));
  return { key, sizeBytes: body.length, contentType: 'audio/wav' };
}

export class BrowserCallRecorder {
  constructor(call, dependencies = {}) {
    this.call = call;
    this.dependencies = dependencies;
    this.startedAt = (dependencies.now ?? Date.now)();
    this.now = dependencies.now ?? Date.now;
    this.maxSamples = Math.min(
      env.VOICE_RECORDING_MAX_LENGTH_SECONDS * sampleRate,
      Math.floor((env.VOICE_RECORDING_MAX_BYTES - wavHeaderBytes) / (channelCount * bytesPerSample)),
    );
    this.chunks = [];
    this.nextSample = { inbound: 0, outbound: 0 };
    this.finalized = false;
  }

  capture(track, audio) {
    if (this.finalized || !Buffer.isBuffer(audio) || !audio.length || !['inbound', 'outbound'].includes(track)) return;
    const elapsedSample = Math.max(0, Math.floor((this.now() - this.startedAt) * sampleRate / 1000));
    const offset = Math.max(elapsedSample, this.nextSample[track]);
    if (offset >= this.maxSamples) return;
    const bounded = Buffer.from(audio.subarray(0, this.maxSamples - offset));
    this.chunks.push({ track, offset, audio: bounded });
    this.nextSample[track] = offset + bounded.length;
  }

  async finalize() {
    if (this.finalized) return null;
    this.finalized = true;
    const body = createBrowserRecordingWav(this.chunks);
    this.chunks = [];
    if (!body) return null;
    const durationMs = Math.round(((body.length - wavHeaderBytes) / (channelCount * bytesPerSample)) * 1000 / sampleRate);
    return storeBrowserRecording(this.call, body, durationMs, this.dependencies);
  }
}

export function attachBrowserCallRecording(session, dependencies = {}) {
  const recorder = new BrowserCallRecorder(session.call, dependencies);
  const originalSendAudio = session.sendAudio.bind(session);
  session.sendAudio = (audio, options) => {
    recorder.capture('outbound', Buffer.isBuffer(audio) ? audio : Buffer.from(String(audio ?? ''), 'base64'));
    return originalSendAudio(audio, options);
  };
  session.on('media', ({ audio }) => recorder.capture('inbound', audio));
  const finalize = () => {
    void recorder.finalize()
      .then((result) => {
        if (result) logger.info({ stage: 'recording.browser_stored', callId: session.callId,
          sizeBytes: result.sizeBytes }, 'Browser test recording stored privately in B2');
      })
      .catch((error) => logger.error({ err: error, stage: 'recording.browser_failed',
        callId: session.callId }, 'Browser test recording storage failed'));
  };
  session.once('stop', finalize);
  session.once('failure', finalize);
  session.once('closed', finalize);
  return recorder;
}
