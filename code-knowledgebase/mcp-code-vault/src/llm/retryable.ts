/** Heuristic: transient / quota errors where a retry or model rotation may help. */
export function isRetryableLlmError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const low = msg.toLowerCase();
  if (/429|503|502|504|rate|quota|overloaded|throttl|timeout|timed out|econnreset|etimedout|fetch failed|socket|temporar/i.test(low)) {
    return true;
  }
  const code = (err as { status?: number; code?: string | number })?.status;
  if (typeof code === 'number' && (code === 429 || code === 502 || code === 503 || code === 504)) return true;
  const c = String((err as { code?: unknown })?.code ?? '');
  if (c === 'ETIMEDOUT' || c === 'ECONNRESET') return true;
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
