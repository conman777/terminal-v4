import { describe, expect, it } from 'vitest';
import { buildAnthropicBody, buildAnthropicHeaders, buildBedrockConverseInput, buildOpenAiBody, buildOpenAiHeaders, buildResponsesBody, parseRunnerArgs } from './api-agent-runner';
import { API_PROVIDER_DEFINITIONS, azureFoundryEndpoint, vertexEndpoint } from './provider-runtime';

describe('api-agent-runner', () => {
  it('parses provider launch arguments without accepting missing values', () => {
    expect(parseRunnerArgs(['--provider', 'xai', '--model', 'grok-4.5', '--reasoning', 'high'])).toEqual({
      provider: 'xai', model: 'grok-4.5', reasoning: 'high',
    });
    expect(() => parseRunnerArgs(['--provider', 'xai', '--model'])).toThrow(/missing/i);
  });

  it('builds OpenAI-compatible streaming requests with reasoning', () => {
    expect(buildOpenAiBody('deepseek-v4-pro', [
      { role: 'user', content: 'hello' },
    ], 'high')).toEqual({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      reasoning_effort: 'high',
    });
  });

  it('builds Responses API streaming requests for direct OpenAI-style providers', () => {
    expect(buildResponsesBody('gpt-5.4', [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'hello' },
    ], 'high')).toEqual({
      model: 'gpt-5.4',
      input: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'hello' },
      ],
      stream: true,
      reasoning: { effort: 'high' },
    });
  });

  it('omits reasoning from Responses requests when disabled', () => {
    expect(buildResponsesBody('gpt-4.1', [{ role: 'user', content: 'hello' }], 'none')).toEqual({
      model: 'gpt-4.1',
      input: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
  });

  it('omits reasoning for providers whose models do not support it', () => {
    expect(buildOpenAiBody('gpt-4o', [
      { role: 'user', content: 'hello' },
    ])).toEqual({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
  });

  it('uses provider-specific headers for Vertex and Azure Foundry', () => {
    const vertex = API_PROVIDER_DEFINITIONS.find(definition => definition.id === 'vertex')!;
    const azure = API_PROVIDER_DEFINITIONS.find(definition => definition.id === 'azure-foundry')!;
    expect(buildOpenAiHeaders(vertex, 'vertex-token', 'oauth')).toEqual({
      authorization: 'Bearer vertex-token',
      'content-type': 'application/json',
    });
    expect(buildOpenAiHeaders(azure, 'azure-key', 'api-key')).toEqual({
      'api-key': 'azure-key',
      'content-type': 'application/json',
    });
  });

  it('builds Bedrock Converse input without a stream-only OpenAI shape', () => {
    expect(buildBedrockConverseInput('amazon.nova-pro-v1:0', [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'hello' },
    ])).toEqual({
      system: [{ text: 'Be concise.' }],
      messages: [{ role: 'user', content: [{ text: 'hello' }] }],
      inferenceConfig: { maxTokens: 8192 },
    });
  });

  it('constructs Vertex and Azure deployment endpoints from validated configuration', () => {
    const vertex = API_PROVIDER_DEFINITIONS.find(definition => definition.id === 'vertex')!;
    const azure = API_PROVIDER_DEFINITIONS.find(definition => definition.id === 'azure-foundry')!;
    expect(vertexEndpoint(vertex, { GOOGLE_CLOUD_PROJECT: 'project-1', GOOGLE_CLOUD_LOCATION: 'europe-west4' })).toBe(
      'https://europe-west4-aiplatform.googleapis.com/v1/projects/project-1/locations/europe-west4/endpoints/openapi/chat/completions',
    );
    expect(azureFoundryEndpoint(azure, {
      AZURE_FOUNDRY_ENDPOINT: 'https://resource.services.ai.azure.com/',
      AZURE_FOUNDRY_DEPLOYMENT: 'gpt-4.1',
    })).toBe('https://resource.services.ai.azure.com/openai/deployments/gpt-4.1/chat/completions?api-version=2024-10-21');
  });

  it('uses the API-key header for Anthropic API credentials', () => {
    expect(buildAnthropicHeaders('api-key', 'api-key-value')).toEqual({
      'x-api-key': 'api-key-value',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    });
  });

  it('uses the official Bearer OAuth contract for Anthropic Console credentials', () => {
    expect(buildAnthropicHeaders('oauth', 'oauth-token-value')).toEqual({
      authorization: 'Bearer oauth-token-value',
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-app': 'cli',
    });
  });

  it('builds Anthropic Messages requests with system separation', () => {
    expect(buildAnthropicBody('claude-sonnet-5', [
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'hello' },
    ], 'xhigh')).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 8192,
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      system: 'You are concise.',
      output_config: { effort: 'xhigh' },
    });
  });
});
