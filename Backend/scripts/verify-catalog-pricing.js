import assert from 'node:assert/strict';
import {
  normalizeKnowledgeText,
  catalogKeywords,
  catalogListQuestionPattern,
  catalogLookup,
  catalogCategoryCandidates,
  hasKnowledgePrice,
  catalogCategory,
  sharedCatalogCategory,
} from '../src/knowledge-bases/catalog-matching.js';

const items = [
  { name: 'Zea Play', item_key: 'zea-play', attributes: [{ key: 'aliases', value: 'ஸியா ப்ளே,ரியா ப்ளே' }] },
  { name: 'Zea Brain', item_key: 'zea-brain' },
];
assert.equal(normalizeKnowledgeText('விலை எவ்வளவு?'), 'விலை எவ்வளவு');
assert.equal(catalogKeywords.test(normalizeKnowledgeText('ஸியா ப்ளே பேக்கேஜ் என்ன?')), true);
assert.equal(catalogListQuestionPattern.test('என்னென்ன package இருக்கு உங்கள்ட்ட'), true);
assert.equal(catalogListQuestionPattern.test('வேற என்ன packages இருக்கு'), true);
assert.equal(catalogListQuestionPattern.test('package என்னென்ன இருக்கு'), true);
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

const masterCategory = { key: 'master-health-checkup', name: 'Master Health Check-Up Packages' };
const masterItems = ['Silver Package', 'Gold Package', 'Platinum Package'].map((name) => ({
  name,
  attributes: [
    { key: 'aliases', value: [masterCategory.name] },
    { key: 'category', value: masterCategory },
  ],
}));
assert.deepEqual(catalogCategory(masterItems[0]), {
  ...masterCategory, parentKey: null, description: null,
});
assert.equal(sharedCatalogCategory(catalogLookup(masterItems, 'Master Health Check-Up Package'))?.key,
  masterCategory.key);
assert.equal(sharedCatalogCategory([masterItems[0], items[0]]), null);
const categorizedMasterItems = masterItems.map((item) => ({
  ...item, attributes: item.attributes.filter((attribute) => attribute.key !== 'aliases'),
}));
assert.deepEqual(catalogCategoryCandidates(categorizedMasterItems, 'Master Health Checkup Package'),
  categorizedMasterItems);
assert.equal(catalogListQuestionPattern.test('என்ன packagesலாம் வச்சிருக்கீங்க'), true);
console.log('Catalog pricing checks passed');
