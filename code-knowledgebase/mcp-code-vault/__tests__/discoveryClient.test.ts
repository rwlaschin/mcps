/**
 * Tests for discoveryClient: startDiscoveryClient, stopDiscoveryClient, and
 * message handling (throttle, POST to registerUrl). Uses mocks for dgram and http.
 */

import * as dgram from 'dgram';
import * as http from 'http';
import * as https from 'https';
import {
  startDiscoveryClient,
  stopDiscoveryClient,
  tryStartDiscoveryAsPrimary,
  startPrimaryAnnouncer,
  stopPrimaryAnnouncer,
  discoverPrimary
} from '@/discoveryClient';
import { MOCK_STATS_PORT } from './testConstants';

const handlers: Record<string, (...args: unknown[]) => void> = {};
const mockSocket: {
  on: jest.Mock;
  once: jest.Mock;
  bind: jest.Mock;
  setBroadcast: jest.Mock;
  close: jest.Mock;
  send: jest.Mock;
} = {
  on: jest.fn((event: string, fn: (...args: unknown[]) => void) => {
    handlers[event] = fn;
    return mockSocket;
  }) as jest.Mock,
  once: jest.fn((event: string, fn: (...args: unknown[]) => void) => {
    handlers[event] = fn;
    return mockSocket;
  }) as jest.Mock,
  bind: jest.fn((_port: number, cb?: () => void) => {
    setImmediate(() => {
      if (cb) cb();
      const list = handlers['listening'];
      if (list) list();
    });
  }),
  setBroadcast: jest.fn(),
  close: jest.fn(),
  send: jest.fn((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') (cb as (err?: Error | null) => void)(null);
  })
};

jest.mock('dgram', () => ({
  createSocket: jest.fn(() => mockSocket)
}));

const mockHttpRequest = jest.fn();
jest.mock('http', () => ({
  request: (...args: unknown[]) => mockHttpRequest(...args)
}));
jest.mock('https', () => ({
  request: (...args: unknown[]) => mockHttpRequest(...args)
}));

jest.mock('@/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  (global as { __discoveryMockLog?: typeof log }).__discoveryMockLog = log;
  return { logger: { child: () => log } };
});

function getMockLog(): { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock } {
  return (global as unknown as { __discoveryMockLog: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock } }).__discoveryMockLog;
}

function getMessageHandler(): (msg: Buffer) => void {
  return handlers['message'] as (msg: Buffer) => void;
}

function getErrorHandler(): (err: NodeJS.ErrnoException) => void {
  return handlers['error'] as (err: NodeJS.ErrnoException) => void;
}

describe('discoveryClient', () => {
  let consoleInfoSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    stopDiscoveryClient();
    stopPrimaryAnnouncer();
    mockHttpRequest.mockImplementation((options: http.RequestOptions, cb?: (res: http.IncomingMessage) => void) => {
      const req = {
        write: jest.fn(),
        end: jest.fn(),
        setTimeout: jest.fn(),
        destroy: jest.fn(),
        on: jest.fn()
      };
      setImmediate(() => {
        if (typeof cb === 'function') {
          const res = { resume: jest.fn() } as unknown as http.IncomingMessage;
          cb(res);
        }
      });
      return req;
    });
  });

  afterEach(async () => {
    await new Promise((r) => setImmediate(r));
    consoleInfoSpy?.mockRestore();
  });

  describe('startDiscoveryClient', () => {
    it('creates a UDP socket and binds to DISCOVERY_PORT', () => {
      startDiscoveryClient(3100);
      expect(dgram.createSocket).toHaveBeenCalledWith('udp4');
      expect(mockSocket.bind).toHaveBeenCalledWith(9255, expect.any(Function));
    });

    it('is idempotent: second call does not create another socket', () => {
      startDiscoveryClient(MOCK_STATS_PORT);
      startDiscoveryClient(3001);
      expect(dgram.createSocket).toHaveBeenCalledTimes(1);
    });

    it('when message with valid registerUrl is received, POSTs port and projectName', () => {
      startDiscoveryClient(3100);
      const onMessage = getMessageHandler();
      expect(onMessage).toBeDefined();

      const writtenBody: string[] = [];
      mockHttpRequest.mockImplementation((options: http.RequestOptions, cb?: (res: http.IncomingMessage) => void) => {
        const req = {
          write: jest.fn((body: string) => {
            writtenBody.push(body);
          }),
          end: jest.fn(),
          setTimeout: jest.fn(),
          destroy: jest.fn(),
          on: jest.fn()
        };
        if (typeof cb === 'function') cb({ resume: jest.fn() } as unknown as http.IncomingMessage);
        return req;
      });

      const payload = JSON.stringify({
        registerUrl: 'http://192.168.1.1:2999/api/register'
      });
      onMessage(Buffer.from(payload, 'utf8'));

      expect(mockHttpRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: '/api/register',
          hostname: '192.168.1.1'
        }),
        expect.any(Function)
      );
      const opts = mockHttpRequest.mock.calls[0][0] as http.RequestOptions;
      expect(Number(opts.port)).toBe(2999);
      expect(writtenBody).toHaveLength(1);
      expect(JSON.parse(writtenBody[0])).toEqual({ port: 3100, projectName: 'mcp-3100' });
    });

    it('ignores message without registerUrl', () => {
      startDiscoveryClient(MOCK_STATS_PORT);
      const onMessage = getMessageHandler();
      onMessage(Buffer.from('{}', 'utf8'));
      onMessage(Buffer.from('{"registerUrl":""}', 'utf8'));
      onMessage(Buffer.from('{"registerUrl":"ftp://x"}', 'utf8'));
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it('error handler logs EADDRINUSE as info', () => {
      startDiscoveryClient(MOCK_STATS_PORT);
      const onError = getErrorHandler();
      const err = new Error('bind EADDRINUSE') as NodeJS.ErrnoException;
      err.code = 'EADDRINUSE';
      onError(err);
      expect(getMockLog().info).toHaveBeenCalledWith(expect.objectContaining({ msg: expect.stringContaining('9255') }));
    });

    it('error handler logs other errors via logger', () => {
      startDiscoveryClient(MOCK_STATS_PORT);
      const onError = getErrorHandler();
      onError(new Error('other') as NodeJS.ErrnoException);
      expect(getMockLog().error).toHaveBeenCalled();
    });
  });

  describe('stopDiscoveryClient', () => {
    it('closes socket and clears state', () => {
      startDiscoveryClient(MOCK_STATS_PORT);
      stopDiscoveryClient();
      expect(mockSocket.close).toHaveBeenCalled();
      startDiscoveryClient(3001);
      expect(dgram.createSocket).toHaveBeenCalledTimes(2);
    });

    it('is safe to call when never started', () => {
      expect(() => stopDiscoveryClient()).not.toThrow();
    });
  });

  describe('tryStartDiscoveryAsPrimary', () => {
    it('resolves true when no one holds 9255 and socket binds', async () => {
      const result = await tryStartDiscoveryAsPrimary(3100);
      expect(result).toBe(true);
      expect(dgram.createSocket).toHaveBeenCalledWith('udp4');
      expect(mockSocket.bind).toHaveBeenCalledWith(9255);
    });

    it('resolves false when bind fails with EADDRINUSE', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockSocket.bind.mockImplementationOnce((_port: number, _cb?: () => void) => {
        // Emit error synchronously so promise resolves false before any listening
        const errHandler = handlers['error'];
        if (errHandler) {
          const err = new Error('EADDRINUSE') as NodeJS.ErrnoException;
          err.code = 'EADDRINUSE';
          errHandler(err);
        }
      });
      const result = await tryStartDiscoveryAsPrimary(3100);
      expect(result).toBe(false);
      expect(mockSocket.close).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('is idempotent: second call returns true without double-binding', async () => {
      const first = await tryStartDiscoveryAsPrimary(3100);
      expect(first).toBe(true);
      const second = await tryStartDiscoveryAsPrimary(3101);
      expect(second).toBe(true);
      expect(dgram.createSocket).toHaveBeenCalledTimes(1);
    });

    it('after stopDiscoveryClient, next tryStartDiscoveryAsPrimary can bind again', async () => {
      const a = await tryStartDiscoveryAsPrimary(3100);
      expect(a).toBe(true);
      stopDiscoveryClient();
      const b = await tryStartDiscoveryAsPrimary(3101);
      expect(b).toBe(true);
      expect(dgram.createSocket).toHaveBeenCalledTimes(2);
    });
  });

  describe('startPrimaryAnnouncer / stopPrimaryAnnouncer', () => {
    afterEach(() => {
      stopPrimaryAnnouncer();
      jest.useRealTimers();
    });

    it('schedules UDP sends on interval', () => {
      jest.useFakeTimers();
      startPrimaryAnnouncer('10.0.0.1', 9256);
      jest.advanceTimersByTime(2100);
      expect(mockSocket.send).toHaveBeenCalled();
      stopPrimaryAnnouncer();
    });

    it('is idempotent: second start does nothing', () => {
      jest.useFakeTimers();
      startPrimaryAnnouncer('127.0.0.1', 9256);
      const n = (dgram.createSocket as jest.Mock).mock.calls.length;
      startPrimaryAnnouncer('127.0.0.1', 9256);
      expect((dgram.createSocket as jest.Mock).mock.calls.length).toBe(n);
    });

    it('error on announce socket closes and clears', () => {
      startPrimaryAnnouncer('127.0.0.1', 9256);
      const errFn = handlers['error'] as (e?: Error) => void;
      expect(errFn).toBeDefined();
      errFn(new Error('fail'));
      expect(mockSocket.close).toHaveBeenCalled();
    });
  });

  describe('discoverPrimary', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('resolves null after timeout when no message', async () => {
      jest.useFakeTimers();
      const p = discoverPrimary(1000);
      jest.advanceTimersByTime(1001);
      await expect(p).resolves.toBeNull();
    });

    it('resolves null on socket error', async () => {
      const p = discoverPrimary(60_000);
      await new Promise((r) => setImmediate(r));
      const errorCalls = (mockSocket.on as jest.Mock).mock.calls.filter(([ev]: [string]) => ev === 'error');
      const onError = errorCalls[errorCalls.length - 1]![1] as (e: NodeJS.ErrnoException) => void;
      onError(Object.assign(new Error('e'), { code: 'EACCES' }) as NodeJS.ErrnoException);
      await expect(p).resolves.toBeNull();
    });
  });
});
