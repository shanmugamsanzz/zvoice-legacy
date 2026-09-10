import React, { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, PhoneOff, X } from 'lucide-react';
import { BrowserTestCall } from '../../lib/browserTestCall';
import { apiRequest } from '../../lib/api';
import { invalidateApiResource } from '../../lib/queryClient';

type Transcript = { speaker: string; text: string };
type SavedCall = { id: string; status: string; endedAt: string | null; durationSeconds: number; transcript: Transcript[] };
const refreshCallData = () => Promise.all(
  ['/calls', '/reports', '/dashboard', '/agents', '/insights', '/vqa'].map(invalidateApiResource),
);

export function BrowserTestDialog({ agent, onClose }: { agent: { id: string; name: string }; onClose: () => void }) {
  const call = useRef<BrowserTestCall | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const [status, setStatus] = useState('Ready to test');
  const [started, setStarted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState('');
  const [callId, setCallId] = useState('');
  const [transcript, setTranscript] = useState<Transcript[]>([]);
  const [saved, setSaved] = useState<SavedCall | null>(null);
  const [reportError, setReportError] = useState('');
  const [reportAttempt, setReportAttempt] = useState(0);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    return () => { mounted.current = false; call.current?.end(); };
  }, []);
  useEffect(() => { transcriptEnd.current?.scrollIntoView({ block: 'nearest' }); }, [transcript]);
  useEffect(() => {
    if (status !== 'Call connected' || ended) return;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [status, ended]);
  useEffect(() => {
    if (!ended || !callId) return;
    let canceled = false;
    let timer: number;
    let attempts = 0;
    const controller = new AbortController();
    setReportError('');
    const poll = async () => {
      try {
        const result = await apiRequest<SavedCall>(`/calls/${callId}`, { zeaCache: 'bypass', signal: controller.signal });
        if (canceled) return;
        if (result.endedAt) {
          setSaved(result);
          setTranscript(result.transcript);
          await refreshCallData();
          return;
        }
        if (++attempts >= 40) { setReportError('The call report is still processing. Check Reports or retry below.'); return; }
        timer = window.setTimeout(() => void poll(), 1000);
      } catch (reason) {
        if (!canceled) setReportError(reason instanceof Error ? reason.message : 'Could not load the call report.');
      }
    };
    void poll();
    return () => { canceled = true; controller.abort(); window.clearTimeout(timer); };
  }, [ended, callId, reportAttempt]);

  const start = () => {
    if (call.current) return;
    setStarted(true);
    call.current = new BrowserTestCall({
      onStatus: (value) => { if (mounted.current) setStatus(value); },
      onCall: (id) => { if (mounted.current) setCallId(id); },
      onTranscript: (speaker, text) => { if (mounted.current) setTranscript((items) => [...items, { speaker, text }]); },
      onEnded: (message) => {
        void refreshCallData();
        if (!mounted.current) return;
        setEnded(true);
        setStatus('Call ended');
        if (message) setError(message);
      },
    });
    void call.current.start(agent.id);
  };
  const close = () => { call.current?.end(); onClose(); };

  return <dialog ref={dialog} onCancel={(event) => { event.preventDefault(); close(); }}
    aria-labelledby="browser-test-title" className="m-auto w-[min(36rem,94vw)] max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-800 shadow-2xl backdrop:bg-black/60">
    <div className="flex items-start justify-between gap-4">
      <div><h2 id="browser-test-title" className="text-lg font-bold">Test Agent · {agent.name}</h2>
        <p className="mt-1 text-xs text-slate-500">Talk to your agent from this browser. Use headphones for clearer audio.</p></div>
      <button onClick={close} aria-label="Close test call" className="rounded-lg p-2 hover:bg-slate-100"><X size={18} /></button>
    </div>
    <div className="my-5 rounded-xl border border-indigo-100 bg-indigo-50 p-4">
      <div className="flex items-center justify-between font-semibold"><span role="status">{status}</span>
        <span className="font-mono">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span></div>
      <p className="mt-2 text-xs text-slate-600">Calls last up to 10 minutes. Transcripts, audio recordings, duration, and provider usage are saved privately in Reports and included in analytics.</p>
    </div>
    {error && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    <div className="flex gap-3">
      {!started && <button autoFocus onClick={start} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 p-3 text-sm font-bold text-white"><Mic size={16} />Start test call</button>}
      {started && !ended && <>
        <button onClick={() => { call.current?.setMuted(!muted); setMuted(!muted); }} aria-pressed={muted}
          className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-slate-200 p-3 text-sm font-bold">
          {muted ? <MicOff size={16} /> : <Mic size={16} />}{muted ? 'Unmute' : 'Mute'}</button>
        <button onClick={() => call.current?.end()} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-red-600 p-3 text-sm font-bold text-white"><PhoneOff size={16} />End call</button>
      </>}
    </div>
    <h3 className="mb-2 mt-5 text-sm font-bold">{saved ? 'Saved transcript' : 'Live transcript'}</h3>
    <div className="max-h-60 space-y-3 overflow-y-auto rounded-xl border border-slate-200 p-4" role="log" aria-live="polite">
      {!transcript.length && <p className="text-sm text-slate-400">Your conversation will appear here.</p>}
      {transcript.map((entry, index) => <div key={index} className="text-sm"><span className="font-bold">{entry.speaker === 'user' ? 'You' : entry.speaker === 'agent' ? agent.name : 'System'}: </span>{entry.text}</div>)}
      <div ref={transcriptEnd} />
    </div>
    {callId && <div className="mt-4 text-xs text-slate-500">
      <p className="break-all">Call ID: <span className="select-all font-mono">{callId}</span></p>
      {ended && <p className="mt-2" role="status">{saved ? `Saved to Reports · ${saved.status} · ${saved.durationSeconds}s` : reportError || 'Saving call report…'}</p>}
      {reportError && <button onClick={() => setReportAttempt((value) => value + 1)} className="mt-2 font-bold text-indigo-600">Retry loading report</button>}
    </div>}
    {ended && <button onClick={close} className="mt-5 w-full rounded-xl border border-slate-200 p-3 text-sm font-bold">Done</button>}
  </dialog>;
}
