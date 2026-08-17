jest.mock('@langchain/google-genai', () => ({
  ChatGoogleGenerativeAI: jest.fn().mockImplementation((opts: { apiKey?: string; model?: string }) => ({
    _mock: true,
    ...opts
  }))
}));

import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { getGeminiLLM } from '../src/llm';

describe('getGeminiLLM', () => {
  it('instantiates ChatGoogleGenerativeAI with api key and model', () => {
    const llm = getGeminiLLM('test-api-key');
    expect(ChatGoogleGenerativeAI).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      model: 'gemini-pro'
    });
    expect(llm).toMatchObject({ apiKey: 'test-api-key', model: 'gemini-pro' });
  });
});
