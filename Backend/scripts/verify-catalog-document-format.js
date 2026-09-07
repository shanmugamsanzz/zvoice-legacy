import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';

const { processExtractedCategory } = await import('../src/knowledge-bases/category-processors.js');
const source = await readFile(new URL('../docs/zea-ai-family-catalog.txt', import.meta.url), 'utf8');
const result = processExtractedCategory('catalog', {
  fullText: source,
  pages: [{ pageNumber: 1, lines: source.split(/\r?\n/u) }],
});

assert.equal(result.recordCount, 18);
assert.equal(result.catalog.name, 'Zea AI Family Catalog');
assert.equal(result.catalog.catalogType, 'service_catalog');
assert.equal(result.catalog.commercialRules.length, 6);

const starter = result.records.find((record) => record.itemKey === 'zeacrm-starter');
assert.equal(starter.description.startsWith('ZeaCRM subscription plan'), true);
assert.equal(starter.price, 10000);
assert.equal(starter.currency, 'INR');
assert.equal(starter.attributes.find((entry) => entry.key === 'aliases').value.includes('CRM'), true);

const enterprise = result.records.find((record) => record.itemKey === 'zeacrm-enterprise');
assert.equal(enterprise.price, null);
assert.equal(enterprise.attributes.find((entry) => entry.key === 'pricing').value, 'custom / contact sales');

console.log(JSON.stringify({
  catalog: result.catalog.name,
  items: result.recordCount,
  commercialRules: result.catalog.commercialRules.length,
  descriptions: 'preserved',
  aliases: 'preserved',
}, null, 2));
