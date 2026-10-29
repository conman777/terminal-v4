import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const definitions = JSON.parse(await readFile(new URL('../rust/crates/api/src/agent_provider_definitions.json', import.meta.url), 'utf8'));
const provider = id => {
  const entry = definitions.find(value => value.id === id);
  assert.ok(entry, `Missing provider ${id}`);
  return entry;
};

test('Alibaba Coding Plan uses its dedicated endpoint and credential without PAYG fallback', () => {
  const entry = provider('alibaba-coding-plan');
  assert.equal(entry.baseUrl, 'https://coding-intl.dashscope.aliyuncs.com/v1');
  assert.deepEqual(entry.envKeys, ['ALIBABA_CODING_PLAN_API_KEY']);
  assert.equal(entry.durableTasks, false);
});

test('Moonshot PAYG endpoints are explicitly labelled as API services', () => {
  for (const id of ['kimi-coding', 'kimi-coding-cn']) {
    const entry = provider(id);
    assert.match(entry.label, /Moonshot.*API/);
    assert.doesNotMatch(entry.label, /Coding|subscription/i);
  }
});

test('own API authentication does not advertise an unimplemented console OAuth flow', () => {
  const entry = provider('anthropic-api');
  assert.deepEqual(entry.authMethods, ['api-key']);
  assert.equal(entry.oauthCommand, undefined);
  assert.equal(entry.oauthHelp, undefined);
});

test('retired Anthropic API models are excluded from selectable metadata', () => {
  const ids = provider('anthropic-api').models.map(value => value.id);
  for (const retired of ['claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-opus-4-1-20250805']) {
    assert.equal(ids.includes(retired), false, retired);
  }
  assert.equal(ids.includes('claude-fable-5'), true);
});

test('provider metadata has unique identifiers and exactly one selectable default', () => {
  assert.equal(new Set(definitions.map(value => value.id)).size, definitions.length);
  for (const entry of definitions) {
    const models = entry.models || [];
    assert.equal(new Set(models.map(value => value.id)).size, models.length, entry.id);
    if (models.length) assert.equal(models.filter(value => value.default).length, 1, entry.id);
  }
});

// TEST-ONLY UNAPPLIED PREVIEW: append to scripts/provider-metadata.test.mjs.
// Uses its existing test/assert/provider bindings; do not run this file alone.
test('Anthropic API exposes an explicit host endpoint override without changing authentication or defaults', () => {
  const entry = provider('anthropic-api');
  assert.equal(entry.baseUrlEnvKey, 'ANTHROPIC_BASE_URL');
  assert.equal(entry.baseUrl, 'https://api.anthropic.com');
  assert.equal(entry.transport, 'anthropic-messages');
  assert.equal(entry.auth, 'api-key');
  assert.deepEqual(entry.authMethods, ['api-key']);
  assert.equal(entry.models.find(model => model.id === 'claude-fable-5').imageInput, true);
  assert.equal(entry.models.find(model => model.id === 'claude-haiku-4-5-20251001').imageInput, undefined);
});
