import type { BaseMessage } from '@langchain/core/messages';

/** Normalize LangChain message `content` (string or multimodal blocks) to plain text. */
export function messageContentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (typeof p === 'string') {
        parts.push(p);
        continue;
      }
      if (p && typeof p === 'object') {
        const o = p as { type?: string; text?: string };
        if (typeof o.text === 'string') parts.push(o.text);
      }
    }
    return parts.join('');
  }
  return '';
}

export function baseMessageText(msg: BaseMessage): string {
  return messageContentToString(msg.content);
}
