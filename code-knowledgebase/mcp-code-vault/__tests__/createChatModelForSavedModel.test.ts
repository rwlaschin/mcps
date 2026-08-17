jest.mock('@langchain/google-genai', () => ({
  ChatGoogleGenerativeAI: jest.fn().mockImplementation((opts: unknown) => ({ kind: 'google', opts }))
}));
jest.mock('@langchain/openai', () => ({
  ChatOpenAI: jest.fn().mockImplementation((opts: unknown) => ({ kind: 'openai', opts }))
}));
jest.mock('@langchain/anthropic', () => ({
  ChatAnthropic: jest.fn().mockImplementation((opts: unknown) => ({ kind: 'anthropic', opts }))
}));

import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { createChatModelForSavedModel } from '../src/llm/createChatModelForSavedModel';

describe('createChatModelForSavedModel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('builds Google model', () => {
    const m = createChatModelForSavedModel(
      { name: 'gemini-2.0-flash', provider: 'google', label: 'G', api_base_url: undefined, local_api_mode: undefined },
      { apiKey: 'k' },
      { temperature: 0.1 }
    );
    expect(m).toMatchObject({ kind: 'google' });
    expect(ChatGoogleGenerativeAI).toHaveBeenCalled();
  });

  it('returns null without Google key', () => {
    expect(
      createChatModelForSavedModel(
        { name: 'x', provider: 'gemini', label: 'x', api_base_url: undefined, local_api_mode: undefined },
        { apiKey: '' }
      )
    ).toBeNull();
  });

  it('builds OpenAI with base URL', () => {
    createChatModelForSavedModel(
      {
        name: 'gpt-4o-mini',
        provider: 'openai_compatible',
        label: 'oc',
        api_base_url: undefined,
        local_api_mode: undefined
      },
      { apiKey: 'sk', baseUrl: 'https://example.com/v1' }
    );
    expect(ChatOpenAI).toHaveBeenCalled();
  });

  it('builds Anthropic', () => {
    createChatModelForSavedModel(
      {
        name: 'claude-3-5-haiku-latest',
        provider: 'anthropic',
        label: 'a',
        api_base_url: undefined,
        local_api_mode: undefined
      },
      { apiKey: 'ant' }
    );
    expect(ChatAnthropic).toHaveBeenCalled();
  });

  it('builds local OpenAI-compatible stack', () => {
    createChatModelForSavedModel(
      {
        name: 'llama3',
        provider: 'local',
        label: 'l',
        api_base_url: 'http://127.0.0.1:11434',
        local_api_mode: 'openai'
      },
      { apiKey: '', baseUrl: undefined, localApiMode: 'openai' }
    );
    expect(ChatOpenAI).toHaveBeenCalled();
  });

  it('returns null for unknown provider', () => {
    expect(
      createChatModelForSavedModel(
        { name: 'x', provider: 'unknown-vendor', label: 'u', api_base_url: undefined, local_api_mode: undefined },
        { apiKey: 'k' }
      )
    ).toBeNull();
  });
});
