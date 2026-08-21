export function normalizeInterruptionText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}']+/gu, ' ').trim().replace(/\s+/gu, ' ');
}

export function meaningfulWordCount(value) {
  return normalizeInterruptionText(value).match(/[\p{L}\p{M}\p{N}]+/gu)?.length ?? 0;
}

export function interruptionDecision(value, options = {}) {
  const text = normalizeInterruptionText(value);
  const acknowledgements = new Set((options.acknowledgements ?? []).map(normalizeInterruptionText));
  const explicitPhrases = (options.explicitStopPhrases ?? []).map(normalizeInterruptionText).filter(Boolean);
  const explicitStop = explicitPhrases.includes(text);
  const acknowledgement = acknowledgements.has(text);
  const wordCount = meaningfulWordCount(text);
  const minimumWords = Number.isInteger(options.minimumWords) ? options.minimumWords : 2;
  return {
    text,
    wordCount,
    explicitStop,
    acknowledgement,
    confirmed: explicitStop || (!acknowledgement && wordCount >= minimumWords),
    reason: explicitStop ? 'explicit_stop' : acknowledgement ? 'acknowledgement'
      : wordCount >= minimumWords ? 'transcript_confirmed' : 'insufficient_words',
  };
}
