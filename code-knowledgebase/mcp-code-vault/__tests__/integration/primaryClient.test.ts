/**
 * Integration tests for primaryClient: connect to primary at 9256, handshake, get statsPort; on disconnect callback.
 * Requires port 9256 to be free (no other primary server running). Run: npm run test:integration
 */

import { startPrimaryServer, stopPrimaryServer } from '@/primaryServer';
import {
  connectToPrimary,
  onPrimaryDisconnect,
  disconnectFromPrimary
} from '@/primaryClient';

describe('primaryClient (integration)', () => {
  afterEach(async () => {
    disconnectFromPrimary();
    await stopPrimaryServer();
  });

  it('connectToPrimary resolves to { statsPort } and keeps socket open when primary is running', async () => {
    startPrimaryServer(3999);

    const result = await connectToPrimary(3100, 'my-proj');
    expect(result).not.toBeNull();
    expect(result).toEqual({ statsPort: 3999 });

    disconnectFromPrimary();
  });

  it('when primary server closes connection, onPrimaryDisconnect callback is invoked', async () => {
    startPrimaryServer(3000);

    const disconnectCb = jest.fn();
    onPrimaryDisconnect(disconnectCb);

    const result = await connectToPrimary(3100, 'p');
    expect(result).toEqual({ statsPort: 3000 });

    await stopPrimaryServer();

    await new Promise<void>((resolve) => {
      if (disconnectCb.mock.calls.length > 0) {
        resolve();
        return;
      }
      setTimeout(() => resolve(), 100);
    });
    expect(disconnectCb).toHaveBeenCalled();
  });

  it('connectToPrimary resolves to null when nothing is listening on 9256', async () => {
    const result = await connectToPrimary(3100, 'p');
    expect(result).toBeNull();
  });

  it('disconnectFromPrimary closes socket and clears callback', async () => {
    startPrimaryServer(3000);

    const disconnectCb = jest.fn();
    onPrimaryDisconnect(disconnectCb);
    const result = await connectToPrimary(3100, 'p');
    expect(result).toEqual({ statsPort: 3000 });

    disconnectFromPrimary();

    await stopPrimaryServer();
    await new Promise((r) => setTimeout(r, 50));
    expect(disconnectCb).not.toHaveBeenCalled();
  });
});
