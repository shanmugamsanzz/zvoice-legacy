export function normalizeInterruptionText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}']+/gu, ' ').trim().replace(/\s+/gu, ' ');
}

export function meaningfulWordCount(value) {
  return normalizeInterruptionText(value).match(/[\p{L}\p{M}\p{N}]+/gu)?.length ?? 0;
}

// Match a whole utterance made only of saved phrases. This supports repetitions
// and combinations ("okay okay", "hello hi") without swallowing a real request
// such as "okay but tell me the price". No language-specific aliases are assumed.
export function matchesPhraseSequence(value, phrases = []) {
  const text = normalizeInterruptionText(value);
  if (!text) return false;
  const words = text.split(' ');
  const candidates = [...new Set(phrases.map(normalizeInterruptionText).filter(Boolean))]
    .map((phrase) => phrase.split(' '));
  const reachable = new Set([0]);
  for (let index = 0; index < words.length; index++) {
    if (!reachable.has(index)) continue;
    for (const phrase of candidates) {
      if (index + phrase.length <= words.length && phrase.every((word, offset) => word === words[index + offset])) {
        reachable.add(index + phrase.length);
      }
    }
  }
  return reachable.has(words.length);
}

export function interruptionDecision(value, options = {}) {
  const text = normalizeInterruptionText(value);
  const explicitStop = matchesPhraseSequence(text, options.explicitStopPhrases);
  const callCheck = !explicitStop && matchesPhraseSequence(text, options.callCheckPhrases);
  const acknowledgement = !explicitStop && !callCheck && matchesPhraseSequence(text, options.acknowledgements);
  const wordCount = meaningfulWordCount(text);
  const minimumWords = Number.isInteger(options.minimumWords) ? options.minimumWords : 2;
  return {
    text,
    wordCount,
    explicitStop,
    acknowledgement,
    callCheck,
    confirmed: explicitStop || (!acknowledgement && !callCheck && wordCount >= minimumWords),
    reason: explicitStop ? 'explicit_stop' : callCheck ? 'call_check' : acknowledgement ? 'acknowledgement'
      : wordCount >= minimumWords ? 'transcript_confirmed' : 'insufficient_words',
  };
}
