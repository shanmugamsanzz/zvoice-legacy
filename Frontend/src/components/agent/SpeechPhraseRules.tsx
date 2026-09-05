import React, { useId, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { VoiceAgent } from '../../types';

export const defaultContinuePhrases = ['ம்', 'ஹம்', 'ஆமா', 'சரி', 'ok', 'okay', 'sure', 'சொல்லுங்க', 'ஆ', 'ஆம்', 'yes', 'hmm', 'ama', 'solunga'];
export const defaultStopPhrases = ['நிறுத்துங்க', 'ஒரு நிமிஷம்', 'கொஞ்சம் இருங்க', 'wait', 'stop', 'வேண்டாம்'];
export const defaultCallCheckPhrases = ['வணக்கம்', 'hello', 'கேக்குதா', 'இருக்கீங்களா', 'hi'];
export const defaultCallCheckResponse = 'ஆமா, கேக்குது. சொல்லுங்க.';

function PhraseList({ label, phrases, disabled, onChange }: {
  label: string; phrases: string[]; disabled: boolean; onChange: (phrases: string[]) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const add = () => {
    const phrase = draft.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!phrase) return;
    if (phrases.length >= 100) { setError('Use up to 100 phrases.'); return; }
    if (phrases.some((value) => value.normalize('NFKC').toLowerCase() === phrase.toLowerCase())) {
      setError('This phrase is already added.'); return;
    }
    onChange([...phrases, phrase]); setDraft(''); setError('');
  };
  return <div className="space-y-3">
    <label htmlFor={id} className="block text-xs font-bold text-slate-700">{label}</label>
    <div className="flex gap-2">
      <input id={id} value={draft} maxLength={160} disabled={disabled} placeholder="Enter a phrase"
        onChange={(event) => { setDraft(event.target.value); setError(''); }}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); add(); } }}
        className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none focus:border-pink-500" />
      <button type="button" disabled={disabled || !draft.trim()} onClick={add}
        className="flex items-center gap-1 rounded-lg bg-pink-50 px-3 py-2 text-xs font-bold text-pink-700 disabled:opacity-40"><Plus size={14} />Add</button>
    </div>
    {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
    <div className="flex flex-wrap gap-2">
      {phrases.map((phrase, index) => <span key={`${phrase}-${index}`} className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700">
        {phrase}{!disabled && <button type="button" aria-label={`Remove ${phrase}`} onClick={() => onChange(phrases.filter((_, position) => position !== index))}><X size={13} /></button>}
      </span>)}
      {!phrases.length && <span className="text-xs text-slate-400">No phrases added.</span>}
    </div>
  </div>;
}

export function SpeechPhraseRules({ agent, disabled, onChange }: {
  agent: VoiceAgent; disabled: boolean; onChange: (settings: Partial<VoiceAgent>) => void;
}) {
  return <section className="space-y-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
    <div><h4 className="text-sm font-extrabold text-slate-800">Speech Phrase Rules</h4>
      <p className="mt-1 text-xs text-slate-500">Continue phrases keep agent audio playing. Explicit stop phrases request a safe interruption.</p></div>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="text-xs font-bold text-slate-700">Minimum Meaningful Words
        <select disabled={disabled} value={agent.interruptionMinWords ?? 2} onChange={(event) => onChange({ interruptionMinWords: Number(event.target.value) })}
          className="mt-2 block w-full rounded-lg border border-slate-200 p-3 text-xs">
          {[1, 2, 3, ...(Number(agent.interruptionMinWords) > 3 ? [agent.interruptionMinWords!] : [])].map((count) => <option key={count} value={count}>{count} {count === 1 ? 'word' : 'words'}</option>)}
        </select>
      </label>
      <label className="text-xs font-bold text-slate-700">Confirmation Delay (ms)
        <input type="number" min={50} max={2000} step={50} disabled={disabled} value={agent.interruptionConfirmationMs ?? 350}
          onChange={(event) => onChange({ interruptionConfirmationMs: Math.min(2000, Math.max(50, Number(event.target.value) || 350)) })}
          className="mt-2 block w-full rounded-lg border border-slate-200 p-3 text-xs" />
      </label>
    </div>
    <PhraseList label="Acknowledgement / Continue Phrases" disabled={disabled} phrases={agent.interruptionAcknowledgements ?? []} onChange={(phrases) => onChange({ interruptionAcknowledgements: phrases })} />
    <p className="text-xs text-slate-500">Repeated saved phrases such as “okay okay” also keep playback going. Add each spelling your caller uses: “okay” and “ஓகே” are separate entries. A longer request such as “okay, but…” can interrupt. After the agent finishes, acknowledgements remain valid answers.</p>
    <PhraseList label="Explicit Stop Phrases (optional)" disabled={disabled} phrases={agent.interruptionStopPhrases ?? []} onChange={(phrases) => onChange({ interruptionStopPhrases: phrases })} />
    <PhraseList label="Call Check Phrases" disabled={disabled} phrases={agent.callCheckPhrases ?? []} onChange={(phrases) => onChange({ callCheckPhrases: phrases })} />
    <p className="text-xs text-slate-500">Repetitions such as “ஹலோ ஹலோ” match the saved “ஹலோ” phrase. Add Tamil and English spellings separately.</p>
    <label className="block text-xs font-bold text-slate-700">Call Check Response
      <textarea rows={2} maxLength={500} disabled={disabled} value={agent.callCheckResponse ?? ''} onChange={(event) => onChange({ callCheckResponse: event.target.value })}
        className="mt-2 block w-full rounded-lg border border-slate-200 p-3 text-xs font-normal" />
    </label>
    <p className="text-xs text-slate-500">Saved as the short immediate response for a configured call-check phrase. It is kept separate from Knowledge Base and LLM instructions. The agent pauses existing audio before replying. Leave the response empty to disable call checks.</p>
    <p className="text-xs font-semibold text-slate-500">Use Save Changes to apply these rules to new calls.</p>
  </section>;
}
