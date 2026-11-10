import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { attachmentText, boundItems, itemLine, parseAttachment } = await import(pathToFileURL(process.argv[2]).href);
const config = JSON.parse(readFileSync(0, 'utf8'));
const budget = { fullChars: config.userMessageChars, indexChars: config.userIndexChars };
const cases = [];
for (const [name, count, text] of [
  ['short', 10, 'Keep the example requirement.'],
  ['medium', 100, 'Example requirement. '.repeat(15)],
  ['long', 1000, 'Example requirement. '.repeat(15)],
  ['extended', 10000, 'Example requirement. '.repeat(15)],
  ['oversize-message', 1, 'Q'.repeat(budget.fullChars * 2)],
  ['escaped-unicode', 200, 'Quote " / newline\n / symbol 😀 / rule. '.repeat(8)],
]) {
  const input = Array.from({length: count}, (_, i) => ({kind: 'full', turn: i + 1, time: '01-01 00:00', text: [text]}));
  const bounded = boundItems(input, budget);
  const appendix = attachmentText(bounded, {sessionId: 'session-example', turns: [1, count]});
  const full = bounded.filter(item => item.kind === 'full');
  const indexed = bounded.filter(item => item.kind !== 'full');
  const fullUnits = full.reduce((n, item) => n + itemLine(item).length + 1, 0);
  const indexUnits = indexed.reduce((n, item) => n + itemLine(item).length + 1, 0);
  assert.ok(fullUnits <= budget.fullChars);
  assert.ok(indexUnits <= budget.indexChars);
  assert.deepEqual(parseAttachment(appendix), bounded);
  assert.equal(bounded.reduce((n, item) => n + (item.kind === 'range' ? item.count : 1), 0), count);
  const unbounded = attachmentText(input, {sessionId: 'session-example', turns: [1, count]});
  const targetUnits = config.retainTokens * 4 + config.summaryChars + appendix.length;
  cases.push({name, user_messages: count, full_items: full.length,
    index_items: bounded.filter(item => item.kind === 'index').length,
    merged_messages: bounded.filter(item => item.kind === 'range').reduce((n, item) => n + item.count, 0),
    verbatim_line_utf16_units: fullUnits, index_line_utf16_units: indexUnits,
    framing_utf16_units: appendix.length - fullUnits - indexUnits,
    appendix_utf16_units: appendix.length, appendix_estimated_tokens: Math.ceil(appendix.length / 4),
    unbounded_appendix_utf16_units: unbounded.length,
    illustrative_text_target_estimated_tokens: Math.ceil(targetUnits / 4)});
}
console.log(JSON.stringify({
  measured_with: ['boundItems', 'attachmentText', 'itemLine', 'parseAttachment'],
  cases,
  limits: [
    'The recent-history retention setting is a host estimate, not a strict request-size ceiling.',
    'An oversize model summary is retained when its one shortening attempt fails validation.',
    'Framing is outside both appendix budgets; custom reader hints have unrestricted length.',
    'The illustrative target assumes the model summary fits and the retained tail meets its estimate.',
    'System instructions, tool schemas, attachments, provider formatting and indivisible host messages are excluded.'
  ]
}, null, 2));