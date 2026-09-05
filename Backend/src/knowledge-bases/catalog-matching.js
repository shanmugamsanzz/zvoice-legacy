export function normalizeKnowledgeText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
}

export const priceQuestionPattern = /\b(price|pricing|cost|rate|amount|how much|evlo|vilai)\b|விலை|எவ்வளவு|எவ்ளோ|கட்டணம்/iu;
export const catalogKeywords = /\b(price|pricing|cost|rate|amount|how much|package|plan|tests?|includes?|details?|evlo|vilai)\b|விலை|எவ்வளவு|எவ்ளோ|கட்டணம்|பேக்கேஜ்|பாக்கேஜ்|பிளான்/iu;

function namesFor(item) {
  const aliases = (item.attributes ?? []).filter((attribute) => attribute.key === 'aliases')
    .flatMap((attribute) => Array.isArray(attribute.value)
      ? attribute.value : String(attribute.value ?? '').split(/[,\n|]/u));
  return [item.name, item.item_key, ...aliases].map(normalizeKnowledgeText).filter(Boolean);
}

export function catalogCandidates(items, query) {
  const normalized = normalizeKnowledgeText(query);
  const tokens = new Set(normalized.split(' '));
  return items.filter((item) => namesFor(item).some((name) =>
    (` ${normalized} `).includes(` ${name} `)
    || (() => {
      const identifying = name.split(' ').filter((token) => !['package', 'plan'].includes(token));
      return identifying.length > 0 && identifying.every((token) => tokens.has(token));
    })()));
}

export function hasKnowledgePrice(knowledge) {
  if (!knowledge?.found) return false;
  const sources = knowledge.matches?.length
    ? knowledge.matches.map((match) => match.answer ?? match.content)
    : [knowledge.content];
  return sources.some((value) => /(?:₹|\$|€|£|\b(?:INR|USD|EUR|GBP|Rs\.?))\s*\d|\d[\d,.]*\s*(?:rupees|ரூபாய்|ரூ\b)/iu.test(String(value ?? '')));
}

export function catalogLookup(items, query, history = []) {
  const matches = catalogCandidates(items, query);
  if (matches.length) return matches;
  // Resolve only an explicit reference to the immediately preceding user topic.
  if (!/^(?:(?:அதோட|அதன்|அதுக்கு|இதோட|இதன்)\s*(?:விலை|எவ்வளவு|எவ்ளோ|கட்டணம்|பேக்கேஜ்).*|(?:what is |what's )?(?:its price|its cost|how much is (?:it|that))\??)$/iu.test(String(query).trim())) return [];
  const previous = history.filter((message) => message.role === 'user');
  if (normalizeKnowledgeText(previous.at(-1)?.content) === normalizeKnowledgeText(query)) previous.pop();
  return catalogCandidates(items, previous.at(-1)?.content ?? '');
}
