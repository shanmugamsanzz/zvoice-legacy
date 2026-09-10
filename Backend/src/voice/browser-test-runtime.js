import { attachRealtimeConversationOrchestrator } from './realtime-conversation-orchestrator.js';
import { appendTranscriptEntry } from '../calls/call.service.js';
import { withAuthServiceContext } from '../infrastructure/database-context.js';
import { attachBrowserCallRecording } from './browser-call-recording.service.js';

export function attachBrowserTestRuntime(session) {
  attachBrowserCallRecording(session);
  const send = (message) => {
    if (session.socket.readyState === 1) session.socket.send(JSON.stringify(message));
  };
  const durationTimer = setTimeout(() => session.close(1000, 'Browser test time limit reached'), 600_000);
  durationTimer.unref?.();
  session.once('closed', () => {
    clearTimeout(durationTimer);
    // Give normal transcript/usage finalization time to finish, then catch early initialization failures.
    const cleanup = setTimeout(() => {
      void withAuthServiceContext((client) => client.query(`UPDATE call_sessions
        SET status='failed',ended_at=now(),
          duration_seconds=CASE WHEN answered_at IS NULL THEN 0 ELSE GREATEST(0,ceil(extract(epoch FROM (now()-answered_at))))::int END
        WHERE id=$1 AND ended_at IS NULL`, [session.callId]))
        .catch((error) => session.log.error({ err: error, callId: session.callId }, 'Browser test cleanup failed'));
    }, 30_000);
    cleanup.unref?.();
  });
  const runtime = attachRealtimeConversationOrchestrator(session, {
    appendTranscript: async (entry) => {
      const result = await appendTranscriptEntry(entry);
      send({ event: 'transcript', speaker: entry.speaker, text: entry.text });
      return result;
    },
  });
  void runtime.ready.then(() => {
    if (!runtime.finalized) send({ event: 'ready' });
  }).catch(() => {
    send({ event: 'error', message: 'The voice provider could not start. Check the agent provider settings.' });
    session.close(1011, 'Voice provider initialization failed');
  });
  return runtime;
}
