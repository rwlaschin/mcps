import { ChatGoogleGenerativeAI } from '@langchain/google-genai';

export function getGeminiLLM(apiKey: string) {
  return new ChatGoogleGenerativeAI({
    apiKey,
    model: 'gemini-pro',
  });
}
