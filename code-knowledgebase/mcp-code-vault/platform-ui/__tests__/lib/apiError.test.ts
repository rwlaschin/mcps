import { describe, it, expect } from 'vitest';
import { readApiErrorMessage } from '../../lib/apiError';

describe('readApiErrorMessage', () => {
  it('prefers JSON error string', async () => {
    const res = new Response(JSON.stringify({ error: 'bad name' }), { status: 400, statusText: 'Bad Request' });
    await expect(readApiErrorMessage(res)).resolves.toBe('bad name');
  });

  it('falls back to message field', async () => {
    const res = new Response(JSON.stringify({ message: 'nope' }), { status: 502 });
    await expect(readApiErrorMessage(res)).resolves.toBe('nope');
  });

  it('uses short plain text body', async () => {
    const res = new Response('upstream timeout', { status: 502 });
    await expect(readApiErrorMessage(res)).resolves.toBe('upstream timeout');
  });

  it('uses status when body is unusable', async () => {
    const res = new Response('x'.repeat(300), { status: 503, statusText: 'Service Unavailable' });
    await expect(readApiErrorMessage(res)).resolves.toBe('503 Service Unavailable');
  });
});
