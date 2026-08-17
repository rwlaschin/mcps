/**
 * Unit tests for primary TCP server (getCurrentSecondaries, startPrimaryServer, stopPrimaryServer).
 * Uses mocked net so we don't bind to a real port.
 */

const mockPushToStream = jest.fn();
jest.mock('../src/stats/streamChannel', () => ({
  pushToStream: (...args: unknown[]) => mockPushToStream(...args)
}));

const mockListen = jest.fn((port: number, host: string, cb: () => void) => {
  if (typeof cb === 'function') cb();
});
const mockClose = jest.fn((cb: (err?: Error) => void) => {
  if (typeof cb === 'function') cb();
});
let connectionCallback: ((socket: unknown) => void) | null = null;

const mockCreateServer = jest.fn((cb: (socket: unknown) => void) => {
  connectionCallback = cb;
  return {
    listen: mockListen,
    close: mockClose
  };
});

jest.mock('net', () => ({
  createServer: (cb: (socket: unknown) => void) => mockCreateServer(cb)
}));

const { getCurrentSecondaries, startPrimaryServer, stopPrimaryServer } = require('../src/primaryServer');

describe('primaryServer', () => {
  beforeEach(() => {
    mockPushToStream.mockClear();
    mockListen.mockClear();
    mockClose.mockClear();
    mockCreateServer.mockClear();
    connectionCallback = null;
  });

  afterEach(async () => {
    await stopPrimaryServer();
  });

  describe('getCurrentSecondaries', () => {
    it('returns empty array when no clients connected', () => {
      expect(getCurrentSecondaries()).toEqual([]);
    });
  });

  describe('startPrimaryServer', () => {
    it('creates server and listens on PRIMARY_TCP_PORT', () => {
      startPrimaryServer(3999);
      expect(mockCreateServer).toHaveBeenCalled();
      expect(mockListen).toHaveBeenCalledWith(9256, '127.0.0.1', expect.any(Function));
    });

    it('is idempotent: second call does not create another server', () => {
      startPrimaryServer(3999);
      startPrimaryServer(3999);
      expect(mockCreateServer).toHaveBeenCalledTimes(1);
    });
  });

  describe('stopPrimaryServer', () => {
    it('closes server and clears state', async () => {
      startPrimaryServer(3999);
      await stopPrimaryServer();
      expect(mockClose).toHaveBeenCalled();
      expect(getCurrentSecondaries()).toEqual([]);
    });

    it('is safe to call when server was never started', async () => {
      await expect(stopPrimaryServer()).resolves.toBeUndefined();
    });
  });

  describe('client handshake', () => {
    function mockClientSocket(handlers: Record<string, (...args: unknown[]) => void>) {
      const socket: {
        on: jest.Mock;
        removeListener: jest.Mock;
        write: jest.Mock;
        destroy: jest.Mock;
      } = {
        on: jest.fn(),
        removeListener: jest.fn(),
        write: jest.fn(),
        destroy: jest.fn()
      };
      socket.on.mockImplementation((ev: string, fn: (...a: unknown[]) => void) => {
        handlers[ev] = fn;
        return socket;
      });
      return socket;
    }

    it('writes statsPort and emits secondary:connected on valid line', () => {
      startPrimaryServer(4400);
      expect(connectionCallback).not.toBeNull();
      const handlers: Record<string, (...args: unknown[]) => void> = {};
      const socket = mockClientSocket(handlers);
      (connectionCallback as (s: unknown) => void)(socket);
      handlers.data!(Buffer.from(JSON.stringify({ port: 3100, projectKey: 'myproj' }) + '\n'));
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('"statsPort":4400'));
      expect(mockPushToStream).toHaveBeenCalledWith(
        'secondary:connected',
        expect.stringContaining('3100')
      );
      handlers.close!();
      expect(mockPushToStream).toHaveBeenCalledWith(
        'secondary:disconnected',
        expect.stringContaining('myproj')
      );
    });

    it('falls back projectName to projectKey and destroys on bad JSON', () => {
      startPrimaryServer(4401);
      const h1: Record<string, (...args: unknown[]) => void> = {};
      const socket = mockClientSocket(h1);
      (connectionCallback as (s: unknown) => void)(socket);
      h1.data!(Buffer.from(JSON.stringify({ port: 3200, projectName: 'legacy' }) + '\n'));
      expect(mockPushToStream).toHaveBeenCalledWith(
        'secondary:connected',
        expect.stringContaining('legacy')
      );
      mockPushToStream.mockClear();
      const h2: Record<string, (...args: unknown[]) => void> = {};
      const s2 = mockClientSocket(h2);
      (connectionCallback as (s: unknown) => void)(s2);
      h2.data!(Buffer.from('{bad\n'));
      expect(s2.destroy).toHaveBeenCalled();
    });
  });
});
