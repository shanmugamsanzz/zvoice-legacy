import assert from 'node:assert/strict';
import {
  interruptionDecision,
  meaningfulWordCount,
  normalizeInterruptionText,
} from '../src/voice/interruption/interruption-policy.js';

assert.equal(normalizeInterruptionText('  HOLD   ON! '), 'hold on');
assert.equal(meaningfulWordCount('silver package price'), 3);

const acknowledgement = interruptionDecision('சரி', { acknowledgements: ['சரி'], minimumWords: 2 });
assert.equal(acknowledgement.acknowledgement, true);
assert.equal(acknowledgement.confirmed, false);

const shortNoise = interruptionDecision('hello', { minimumWords: 2 });
assert.equal(shortNoise.confirmed, false);
assert.equal(shortNoise.reason, 'insufficient_words');

const meaningful = interruptionDecision('silver price', { minimumWords: 2 });
assert.equal(meaningful.confirmed, true);
assert.equal(meaningful.reason, 'transcript_confirmed');

const explicitStop = interruptionDecision('stop', { explicitStopPhrases: ['stop'], minimumWords: 2 });
assert.equal(explicitStop.explicitStop, true);
assert.equal(explicitStop.confirmed, true);

const configuredStop = interruptionDecision('please pause now', { explicitStopPhrases: ['please pause now'] });
assert.equal(configuredStop.explicitStop, true);

const rules = { acknowledgements: ['ஆமா', 'hmm', 'சொல்லுங்க'], explicitStopPhrases: ['stop', 'ஒரு நிமிஷம்'], callCheckPhrases: ['கேக்குதா', 'hello'], minimumWords: 2 };
assert.equal(interruptionDecision('ஆமா!', rules).confirmed, false);
assert.equal(interruptionDecision('ஆமா ஆனா எனக்கு', rules).confirmed, true, 'A longer correction must not be ignored as a continue phrase');
assert.equal(interruptionDecision('STOP!', rules).confirmed, true, 'Single-word stops bypass minimum words');
assert.equal(interruptionDecision('hello', rules).callCheck, true);
assert.equal(interruptionDecision('hello package price', rules).callCheck, false, 'Call checks require a whole-utterance match');
assert.equal(interruptionDecision('stop', { ...rules, acknowledgements: ['stop'], callCheckPhrases: ['stop'] }).reason, 'explicit_stop');
const { updateAgentSchema } = await import('../src/agents/agent.schemas.js');
assert.equal(updateAgentSchema.safeParse({ settings: { callCheckPhrases: ['hello'], callCheckResponse: 'Yes, I can hear you.' } }).success, true);
assert.equal(updateAgentSchema.safeParse({ settings: { callCheckResponse: 'x'.repeat(501) } }).success, false);
assert.equal(updateAgentSchema.safeParse({ settings: { callCheckPhrases: [''] } }).success, false);

console.log(JSON.stringify({ success: true, task: 'Voice interruption decision policy' }));
