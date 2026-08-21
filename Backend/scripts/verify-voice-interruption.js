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

console.log(JSON.stringify({ success: true, task: 'Voice interruption decision policy' }));
