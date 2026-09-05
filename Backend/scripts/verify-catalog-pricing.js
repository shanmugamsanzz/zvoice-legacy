import assert from 'node:assert/strict';
import { normalizeKnowledgeText, catalogKeywords, catalogLookup, hasKnowledgePrice } from '../src/knowledge-bases/catalog-matching.js';

const items = [
  { name: 'Zea Play', item_key: 'zea-play', attributes: [{ key: 'aliases', value: 'ஸியா ப்ளே,ரியா ப்ளே' }] },
  { name: 'Zea Brain', item_key: 'zea-brain' },
];
assert.equal(normalizeKnowledgeText('விலை எவ்வளவு?'), 'விலை எவ்வளவு');
assert.equal(catalogKeywords.test(normalizeKnowledgeText('ஸியா ப்ளே பேக்கேஜ் என்ன?')), true);
assert.deepEqual(catalogLookup(items, 'ஸியா ப்ளே விலை எவ்வளவு?'), [items[0]]);
assert.deepEqual(catalogLookup(items, 'Zea unknown price?'), []);
assert.deepEqual(catalogLookup(items, 'display price?'), []);
assert.deepEqual(catalogLookup(items, 'Zea Play and Zea Brain price?'), items);
assert.deepEqual(catalogLookup(items, 'அதோட விலை என்ன?', [
  { role: 'user', content: 'Zea Play பற்றி சொல்லுங்க' },
  { role: 'assistant', content: 'Some description' },
  { role: 'user', content: 'அதோட விலை என்ன?' },
]), [items[0]]);
assert.deepEqual(catalogLookup(items, 'Unknown product price?', [{ role: 'user', content: 'Zea Play' }]), []);
assert.deepEqual(catalogLookup([{ name: 'Package' }], 'price?'), []);
assert.equal(hasKnowledgePrice({ found: true, content: 'Basic INR 999 per month' }), true);
assert.equal(hasKnowledgePrice({ found: true, content: 'There are 3 packages' }), false);
assert.equal(hasKnowledgePrice({ found: false, content: 'INR 999' }), false);
console.log('Catalog pricing checks passed');
