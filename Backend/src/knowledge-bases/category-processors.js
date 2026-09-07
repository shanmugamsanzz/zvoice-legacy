import { env } from '../config/env.js';

function nonEmptyLines(extraction) {
  return extraction.pages.flatMap((page) => page.lines.map((text) => ({ pageNumber: page.pageNumber, text })))
    .filter((line) => line.text.trim());
}

function parseFaq(extraction) {
  const lines = nonEmptyLines(extraction);
  const entries = [];
  let current;
  const flush = () => {
    if (current?.question && current.answer.length) {
      entries.push({
        question: current.question,
        answer: current.answer.join(' ').trim(),
        sourcePageStart: current.pageNumber,
        sourcePageEnd: current.lastPageNumber,
      });
    }
    current = null;
  };
  for (const line of lines) {
    const explicitQuestion = line.text.match(/^(?:q|question)\s*[:.)-]\s*(.+)$/i);
    const explicitAnswer = line.text.match(/^(?:a|answer)\s*[:.)-]\s*(.*)$/i);
    const isQuestion = explicitQuestion || (!explicitAnswer && line.text.endsWith('?'));
    if (isQuestion) {
      flush();
      current = {
        question: (explicitQuestion?.[1] ?? line.text).trim(),
        answer: [],
        pageNumber: line.pageNumber,
        lastPageNumber: line.pageNumber,
      };
      continue;
    }
    if (current) {
      current.answer.push(explicitAnswer?.[1] ?? line.text);
      current.lastPageNumber = line.pageNumber;
    }
  }
  flush();
  return { records: entries, warnings: entries.length ? [] : ['No question-and-answer pairs were detected'] };
}

function priceFromLine(text) {
  const match = text.match(/(?:₹|rs\.?|inr|\$|usd)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(inr|usd)/i);
  if (!match) return null;
  const numeric = Number((match[1] ?? match[2]).replaceAll(',', ''));
  if (!Number.isFinite(numeric)) return null;
  const token = (match[0].match(/₹|rs\.?|inr|\$|usd/i)?.[0] ?? 'INR').toLowerCase();
  const currency = token === '$' || token === 'usd' ? 'USD' : 'INR';
  const name = text.replace(match[0], '').trim().replace(/[-–—:|]+$/u, '').trim();
  return { price: numeric, currency, name };
}

function catalogKey(value, fallback = 'catalog-item') {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '').slice(0, 160) || fallback;
}

function catalogObject(value, warnings, label, lineNumber) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  warnings.push(`${label} on Catalog line ${lineNumber} must be a JSON object`);
  return {};
}

function catalogMetadata(text) {
  const result = {};
  for (const segment of text.split('|')) {
    const match = segment.match(/^\s*([A-Z][A-Z0-9 _-]*)\s*[:=]\s*(.*?)\s*$/iu);
    if (!match) continue;
    const key = match[1].toUpperCase().replace(/[\s-]+/gu, '_');
    result[key] = match[2].trim();
  }
  return result;
}

function parseCatalog(extraction) {
  const lines = nonEmptyLines(extraction);
  const items = [];
  const warnings = [];
  const commercialRules = [];
  const catalog = {
    catalogType: 'document_catalog', name: 'Extracted catalog',
    description: null, defaultCurrency: null,
  };
  let category = null;
  for (let index = 0; index < lines.length; index += 1) {
    const metadata = catalogMetadata(lines[index].text);
    if (metadata.CATALOG) {
      catalog.name = metadata.CATALOG.slice(0, 200);
      catalog.catalogType = catalogKey(metadata.CATALOG_TYPE ?? 'document_catalog').replaceAll('-', '_');
      catalog.description = metadata.DESCRIPTION?.slice(0, 50000) ?? null;
      catalog.defaultCurrency = metadata.DEFAULT_CURRENCY?.toUpperCase() ?? null;
      continue;
    }
    if (metadata.CATEGORY) {
      category = {
        name: metadata.CATEGORY.slice(0, 240),
        key: catalogKey(metadata.CATEGORY_KEY ?? metadata.CATEGORY),
        parentKey: metadata.PARENT_CATEGORY_KEY ? catalogKey(metadata.PARENT_CATEGORY_KEY) : null,
        aliases: String(metadata.ALIASES ?? '').split(',').map((value) => value.trim()).filter(Boolean),
        description: metadata.DESCRIPTION?.slice(0, 50000) ?? null,
        attributes: catalogObject(metadata.ATTRIBUTES, warnings, 'ATTRIBUTES', index + 1),
      };
      continue;
    }
    if (metadata.COMMERCIAL_RULE) {
      commercialRules.push({
        key: catalogKey(metadata.RULE_KEY ?? metadata.COMMERCIAL_RULE),
        name: metadata.COMMERCIAL_RULE.slice(0, 200),
        description: metadata.DESCRIPTION?.slice(0, 50000) ?? null,
      });
      continue;
    }
    if (!metadata.ITEM) continue;
    const explicitPrice = metadata.PRICE === undefined
      ? null : Number(String(metadata.PRICE).replaceAll(',', ''));
    if (metadata.PRICE !== undefined && (!Number.isFinite(explicitPrice) || explicitPrice < 0)) {
      warnings.push(`PRICE on Catalog line ${index + 1} must be a non-negative number`);
      continue;
    }
    const aliases = [
      ...String(metadata.ALIASES ?? '').split(',').map((value) => value.trim()).filter(Boolean),
      ...(category?.aliases ?? []), category?.name,
    ].filter(Boolean);
    const itemAttributes = catalogObject(metadata.ATTRIBUTES, warnings, 'ATTRIBUTES', index + 1);
    const attributes = Object.entries(itemAttributes).map(([key, value], attributeIndex) => ({
      key: catalogKey(key, `attribute-${attributeIndex + 1}`),
      name: key,
      value,
      displayOrder: attributeIndex,
    }));
    attributes.push(
      { key: 'aliases', name: 'Aliases', value: [...new Set(aliases)], displayOrder: attributes.length },
      { key: 'category', name: 'Category', value: category, displayOrder: attributes.length + 1 },
      {
        key: 'relationships', name: 'Relationships',
        value: catalogObject(metadata.RELATIONSHIPS, warnings, 'RELATIONSHIPS', index + 1),
        displayOrder: attributes.length + 2,
      },
      {
        key: 'selection-rules', name: 'Selection Rules',
        value: catalogObject(metadata.SELECTION_RULES, warnings, 'SELECTION_RULES', index + 1),
        displayOrder: attributes.length + 3,
      },
    );
    items.push({
      itemKey: catalogKey(metadata.ITEM_KEY ?? metadata.ITEM, `item-${items.length + 1}`),
      name: metadata.ITEM.slice(0, 240),
      description: metadata.DESCRIPTION?.slice(0, 50000) ?? null,
      price: explicitPrice,
      currency: metadata.CURRENCY?.toUpperCase() ?? (explicitPrice === null ? null : catalog.defaultCurrency),
      attributes,
      sourceText: lines[index].text,
      sourcePageStart: lines[index].pageNumber,
      sourcePageEnd: lines[index].pageNumber,
      displayOrder: items.length,
    });
  }
  for (const item of items) {
    item.attributes.push({
      key: 'commercial-rules', name: 'Commercial Rules', value: commercialRules,
      displayOrder: item.attributes.length,
    });
  }
  return {
    catalog: { ...catalog, commercialRules },
    records: items,
    warnings: [...warnings, ...(!items.length ? ['No valid catalog items were detected'] : [])],
  };
}

function parseWorkflowRules(extraction) {
  const records = [];
  const lines = extraction.pages.flatMap((page) => page.text
    .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6])\s*>/giu, '\n')
    .replace(/\\r?\\n/gu, '\n')
    .replace(/&(?:rarr|#8594|#x0*2192);/giu, '\u2192')
    .replace(/&(?:rArr|#8658|#x0*21d2);/gu, '\u21d2')
    .replace(/&gt;|&#62;|&#x0*3e;/giu, '>')
    .replace(/&lt;|&#60;|&#x0*3c;/giu, '<')
    .replace(/&(?:nbsp|#160|#x0*a0|#32|#x0*20);/giu, ' ')
    .replace(/\s+(?=IF\s+)/gu, '\n')
    .split(/\n/gu)
    .map((text) => ({ pageNumber: page.pageNumber, text })));
  for (const line of lines) {
    const normalized = line.text
      .replace(/<[^>]+>/gu, ' ')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
      .replace(/^\s*(?:[-*#]|\u2022)+\s*/u, '')
      .replace(/^\s*["'`]+|["'`*]+\s*$/gu, '')
      .replace(/\s+/gu, ' ')
      .trim();
    const arrow = normalized.match(/^(.+?)\s*(?:->|=>|\u2192|\u21d2)\s*(.+)$/u);
    const conditional = normalized.match(/^(?:rule\s*:\s*)?if\s+(.+?)\s+then\s+(.+)$/i);
    const match = arrow ?? conditional;
    if (!match) continue;
    const intent = match[1].trim();
    const action = match[2].trim();
    const lowerAction = action.toLowerCase();
    const actionType = lowerAction.includes('transfer') ? 'transfer_call'
      : lowerAction.includes('hangup') || lowerAction.includes('hang up') ? 'hangup_call'
        : lowerAction.includes('schedule') ? 'schedule_callback' : 'respond';
    records.push({
      name: intent.slice(0, 200),
      intent: intent.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 160) || 'rule',
      actionType,
      actionConfig: { instruction: action },
      responseTemplate: actionType === 'respond' ? action : null,
      sourceText: normalized,
      sourcePageStart: line.pageNumber,
      sourcePageEnd: line.pageNumber,
      priority: records.length * 10 + 100,
    });
  }
  return { records, warnings: records.length ? [] : ['No workflow lines using IF/THEN or -> syntax were detected'] };
}

function parseConversation(extraction) {
  const records = nonEmptyLines(extraction).map((line, index) => ({
    flowKey: 'main',
    nodeKey: `node_${index + 1}`,
    nodeType: 'message',
    language: 'en',
    sequenceOrder: index,
    isEntry: index === 0,
    content: line.text,
    sourceText: line.text,
    sourcePageStart: line.pageNumber,
    sourcePageEnd: line.pageNumber,
  }));
  return { records, warnings: records.length ? [] : ['No conversation lines were detected'] };
}

function parseGeneralKnowledge(extraction) {
  const words = extraction.fullText.split(/\s+/u).filter(Boolean);
  const size = env.RAG_CHUNK_SIZE_TOKENS;
  const overlap = env.RAG_CHUNK_OVERLAP_TOKENS;
  const records = [];
  for (let start = 0; start < words.length; start += size - overlap) {
    const chunkWords = words.slice(start, start + size);
    if (!chunkWords.length) break;
    records.push({ chunkIndex: records.length, content: chunkWords.join(' '), tokenCount: chunkWords.length });
    if (start + size >= words.length) break;
  }
  return { records, warnings: [] };
}

const processors = {
  faq: parseFaq,
  catalog: parseCatalog,
  workflow_rules: parseWorkflowRules,
  conversation_script: parseConversation,
  general_knowledge: parseGeneralKnowledge,
};

export function processExtractedCategory(documentType, extraction) {
  const processor = processors[documentType];
  if (!processor) throw new TypeError(`Unsupported knowledge document type: ${documentType}`);
  const result = processor(extraction);
  return { documentType, ...result, recordCount: result.records.length };
}
