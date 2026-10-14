import { describe, expect, it } from 'vitest';
import {
  API_PROVIDER_DEFINITIONS,
  apiEndpoint,
  loadApiProviderStates,
  resolveProviderCredential,
  safeProviderError,
} from './provider-runtime';

describe('provider-runtime', () => {
  it('defines the complete Terminal v4 provider catalog without inheriting reference-runtime identifiers', () => {
    const ids = API_PROVIDER_DEFINITIONS.map(definition => definition.id);
    expect(ids).toEqual([
      'anthropic-api', 'xai', 'xai-oauth', 'openai-api', 'actual', 'copilot', 'deepseek', 'moa',
      'openrouter', 'nous', 'qwen-oauth', 'minimax-oauth', 'copilot-acp', 'lmstudio', 'tencent-tokenhub',
      'zai', 'minimax', 'minimax-cn', 'kimi-coding', 'kimi-coding-cn',
      'alibaba', 'alibaba-coding-plan', 'xiaomi', 'huggingface', 'fireworks',
      'novita', 'nvidia', 'deepinfra', 'gmi', 'arcee', 'stepfun', 'upstage',
      'kilocode', 'ai-gateway', 'opencode-zen', 'opencode-go', 'ollama-cloud',
      'bedrock', 'vertex', 'azure-foundry',
    ]);
    expect(API_PROVIDER_DEFINITIONS.some(definition => definition.id === 'openrouter' && definition.transport === 'openai-chat')).toBe(true);
    expect(API_PROVIDER_DEFINITIONS.some(definition => definition.id === 'minimax' && definition.transport === 'anthropic-messages')).toBe(true);
    expect(API_PROVIDER_DEFINITIONS.some(definition => definition.id === 'bedrock' && definition.transport === 'bedrock-converse')).toBe(true);
    expect(API_PROVIDER_DEFINITIONS.some(definition => definition.id === 'vertex' && definition.transport === 'vertex-openai')).toBe(true);
    expect(API_PROVIDER_DEFINITIONS.some(definition => definition.id === 'azure-foundry' && definition.transport === 'azure-openai')).toBe(true);
    expect(API_PROVIDER_DEFINITIONS.find(definition => definition.id === 'actual')).toMatchObject({
      transport: 'openai-responses',
      auth: 'api-key',
      baseUrl: 'https://api.actual.inc/v1',
    });
    expect(API_PROVIDER_DEFINITIONS.find(definition => definition.id === 'openai-api')).toMatchObject({
      transport: 'openai-responses',
      auth: 'api-key',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(API_PROVIDER_DEFINITIONS.find(definition => definition.id === 'xai-oauth')).toMatchObject({
      transport: 'openai-responses',
      authMethods: ['api-key'],
    });
    expect(API_PROVIDER_DEFINITIONS.find(definition => definition.id === 'lmstudio')).toMatchObject({
      transport: 'openai-chat',
      baseUrl: 'http://127.0.0.1:1234/v1',
    });
    expect(API_PROVIDER_DEFINITIONS.find(definition => definition.id === 'tencent-tokenhub')).toMatchObject({
      transport: 'openai-chat',
      baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    });
    expect(API_PROVIDER_DEFINITIONS.find(definition => definition.id === 'anthropic-api')).toMatchObject({
      transport: 'anthropic-messages',
      auth: 'api-key',
      authMethods: ['api-key', 'oauth'],
      oauthCommand: 'claude auth login --console',
    });
    expect(API_PROVIDER_DEFINITIONS.find(definition => definition.id === 'xai')?.auth).toBe('api-key');
    expect(API_PROVIDER_DEFINITIONS.find(definition => definition.id === 'copilot')?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gpt-4o' }),
      expect.objectContaining({ id: 'gpt-4.1' }),
    ]));
    expect(API_PROVIDER_DEFINITIONS.find(definition => definition.id === 'qwen-oauth')?.authMethods).toEqual(['api-key']);
  });

  it('keeps provider endpoint normalization and redacts long provider errors', () => {
    const definition = API_PROVIDER_DEFINITIONS.find(candidate => candidate.id === 'deepseek');
    expect(apiEndpoint({ ...definition!, baseUrl: 'https://api.example.test/v1/' })).toBe('https://api.example.test/v1');
    expect(safeProviderError(401, 'bad\ncredentials\n'.repeat(100)).message.length).toBeLessThan(340);
  });

  it('normalizes Actual hosted and loopback base URLs to the Responses API root', () => {
    const actual = API_PROVIDER_DEFINITIONS.find(candidate => candidate.id === 'actual')!;
    expect(apiEndpoint(actual, { ACTUAL_BASE_URL: 'https://api.actual.inc' })).toBe('https://api.actual.inc/v1');
    expect(apiEndpoint(actual, { ACTUAL_BASE_URL: 'http://127.0.0.1:8080' })).toBe('http://127.0.0.1:8080/v1');
  });

  it('does not treat a Claude OAuth token as an Anthropic API key', async () => {
    const definition = API_PROVIDER_DEFINITIONS.find(candidate => candidate.id === 'anthropic-api');
    expect(definition?.envKeys).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    const credential = await resolveProviderCredential({ ...definition!, envKeys: [] }, { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-only' });
    expect(credential).toBeNull();
  });

  it('allows no-auth credentials only for explicitly loopback provider endpoints', async () => {
    const actual = API_PROVIDER_DEFINITIONS.find(candidate => candidate.id === 'actual')!;
    const remoteCredential = await resolveProviderCredential(actual, { ACTUAL_BASE_URL: 'https://api.actual.inc/v1' });
    const localCredential = await resolveProviderCredential(actual, { ACTUAL_BASE_URL: 'http://127.0.0.1:8080' });
    expect(remoteCredential).toBeNull();
    expect(localCredential).toBeTruthy();
  });

  it('reports live provider authentication without exposing credentials', async () => {
    const states = await loadApiProviderStates();
    expect(states).toHaveLength(API_PROVIDER_DEFINITIONS.length);
    for (const state of states) {
      expect(state).not.toHaveProperty('credential');
      expect(['ready', 'auth-required', 'not-configured', 'not-installed']).toContain(state.status);
    }
  });
});
