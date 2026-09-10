export function normalizeKnowledgeText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
}

export const priceQuestionPattern = /\b(price|pricing|cost|rate|amount|how much|evlo|vilai)\b|விலை|எவ்வளவு|எவ்ளோ|கட்டணம்/iu;
export const catalogKeywords = /\b(price|pricing|cost|rate|amount|how much|packages?|plans?|tests?|includes?|details?|evlo|vilai)\b|விலை|எவ்வளவு|எவ்ளோ|கட்டணம்|பேக்கேஜ்|பாக்கேஜ்|பிளான்/iu;
const tamilListTerms = String.raw`(?:என்ன|என்னென்ன|எந்தெந்த|வேறு\s*என்ன|வேற\s*என்ன|அனைத்து)`;
const catalogNouns = String.raw`(?:packages?|plans?|services?|பேக்கேஜ்|பாக்கேஜ்|பிளான்|சேவை)`;

export const catalogListQuestionPattern = new RegExp(
  String.raw`\b(?:(?:what|which)\s+(?:other\s+)?(?:packages|plans|services)|(?:list|show)\b.*\b(?:packages?|plans?|services?)|(?:all|available|other)\s+(?:packages|plans|services))\b|${tamilListTerms}.*${catalogNouns}|${catalogNouns}.*${tamilListTerms}`,
  'iu',
);

function namesFor(item) {
  const aliases = (item.attributes ?? []).filter((attribute) => attribute.key === 'aliases')
    .flatMap((attribute) => Array.isArray(attribute.value)
      ? attribute.value : String(attribute.value ?? '').split(/[,\n|]/u));
  return [item.name, item.item_key, ...aliases].map(normalizeKnowledgeText).filter(Boolean);
}

export function catalogCategory(item) {
  const value = (item?.attributes ?? []).find((attribute) => attribute.key === 'category')?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = String(value.name ?? '').trim();
  const key = String(value.key ?? '').trim();
  if (!name && !key) return null;
  return {
    key: key || normalizeKnowledgeText(name).replaceAll(' ', '-'),
    name: name || key,
    parentKey: value.parentKey ?? null,
    description: value.description ?? null,
  };
}

export function sharedCatalogCategory(items) {
  const categories = items.map(catalogCategory);
  if (!categories.length || categories.some((category) => !category)) return null;
  const key = normalizeKnowledgeText(categories[0].key || categories[0].name);
  return categories.every((category) => normalizeKnowledgeText(category.key || category.name) === key)
    ? categories[0] : null;
}

export function catalogCandidates(items, query) {
  const normalized = normalizeKnowledgeText(query);
  const tokens = new Set(normalized.split(' '));
  return items.filter((item) => namesFor(item).some((name) =>
    (` ${normalized} `).includes(` ${name} `)
    || (() => {
      const identifying = name.split(' ')
        .filter((token) => !['package', 'packages', 'plan', 'plans'].includes(token));
      return identifying.length > 0 && identifying.every((token) => tokens.has(token));
    })()));
}

const genericCategoryTokens = new Set([
  'category', 'categories', 'check', 'checkup', 'health', 'package', 'packages', 'plan', 'plans', 'service', 'services', 'up',
]);

export function catalogCategoryCandidates(items, query) {
  const normalized = normalizeKnowledgeText(query);
  const queryTokens = new Set(normalized.split(' '));
  const matchedKeys = new Set();
  for (const item of items) {
    const category = catalogCategory(item);
    if (!category) continue;
    const names = [category.name, category.key].map(normalizeKnowledgeText).filter(Boolean);
    const matched = names.some((name) => {
      if ((` ${normalized} `).includes(` ${name} `)) return true;
      const identifying = name.split(' ').filter((token) => !genericCategoryTokens.has(token));
      return identifying.length > 0 && identifying.every((token) => queryTokens.has(token));
    });
    if (matched) matchedKeys.add(normalizeKnowledgeText(category.key || category.name));
  }
  return items.filter((item) => {
    const category = catalogCategory(item);
    return category && matchedKeys.has(normalizeKnowledgeText(category.key || category.name));
  });
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
  if (!/(?:(?:அதோட|அதன்|அதுக்கு|இதோட|இதன்)[^?]*(?:விலை|எவ்வளவு|எவ்ளோ|கட்டணம்|price)|(?:what is |what's )?(?:its price|its cost|how much is (?:it|that)))/iu.test(String(query).trim())) return [];
  const previous = history.filter((message) => message.role === 'user');
  if (normalizeKnowledgeText(previous.at(-1)?.content) === normalizeKnowledgeText(query)) previous.pop();
  const previousQuery = previous.at(-1)?.content ?? '';
  const previousItems = catalogCandidates(items, previousQuery);
  return previousItems.length ? previousItems : catalogCategoryCandidates(items, previousQuery);
}
