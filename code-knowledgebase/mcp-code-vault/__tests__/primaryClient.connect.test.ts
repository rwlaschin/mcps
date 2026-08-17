/**
 * connectToPrimary: mocked net.Socket to cover handshake, errors, and invalid payloads.
 */

import { EventEmitter } from 'events';
import * as net from 'net';
import { connectToPrimary, disconnectFromPrimary, onPrimaryDisconnect } from '@/primaryClient';

function makeSocket() {
  const s = new EventEmitter() as unknown as net.Socket & {
    write: jest.Mock;
    removeListener: jest.Mock;
    destroy: jest.Mock;
  };
  s.write = jest.fn();
  s.removeListener = jest.fn((ev: string, fn: (...a: unknown[]) => void) => {
    EventEmitter.prototype.removeListener.call(s, ev, fn);
    return s;
  });
  s.destroy = jest.fn();
  return s;
}

const mockConnect = jest.fn();

jest.mock('net', () => ({
  connect: (...args: unknown[]) => mockConnect(...args)
}));

describe('primaryClient connectToPrimary', () => {
  beforeEach(() => {
    mockConnect.mockReset();
    disconnectFromPrimary();
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    disconnectFromPrimary();
    jest.restoreAllMocks();
  });

  it('resolves with statsPort after newline-delimited JSON handshake', async () => {
    const socket = makeSocket();
    mockConnect.mockImplementation((_opts: unknown, cb: () => void) => {
      setImmediate(() => {
        cb();
        setImmediate(() => {
          socket.emit('data', Buffer.from(JSON.stringify({ statsPort: 4000 }) + '\n'));
        });
      });
      return socket;
    });
    await expect(connectToPrimary(3000, 'pk')).resolves.toEqual({ statsPort: 4000 });
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('3000'));
  });

  it('uses discover host and tcpPort when provided', async () => {
    const socket = makeSocket();
    mockConnect.mockImplementation((opts: { host: string; port: number }, cb: () => void) => {
      expect(opts.host).toBe('10.0.0.5');
      expect(opts.port).toBe(9300);
      setImmediate(() => cb());
      return socket;
    });
    setImmediate(() => socket.emit('data', Buffer.from('{"statsPort":1}\n')));
    await connectToPrimary(1, 'k', { host: '10.0.0.5', tcpPort: 9300 });
  });

  it('resolves null when statsPort is not a number', async () => {
    const socket = makeSocket();
    mockConnect.mockImplementation((_o: unknown, cb: () => void) => {
      setImmediate(() => cb());
      return socket;
    });
    setImmediate(() => socket.emit('data', Buffer.from('{"statsPort":"bad"}\n')));
    await expect(connectToPrimary(3000, 'pk')).resolves.toBeNull();
    expect(socket.destroy).toHaveBeenCalled();
  });

  it('resolves null on JSON parse error in first line', async () => {
    const socket = makeSocket();
    mockConnect.mockImplementation((_o: unknown, cb: () => void) => {
      setImmediate(() => cb());
      return socket;
    });
    setImmediate(() => socket.emit('data', Buffer.from('not-json\n')));
    await expect(connectToPrimary(3000, 'pk')).resolves.toBeNull();
    expect(socket.destroy).toHaveBeenCalled();
  });

  it('resolves null on socket error before handshake', async () => {
    const socket = makeSocket();
    mockConnect.mockImplementation(() => socket);
    setImmediate(() => socket.emit('error', Object.assign(new Error('econnrefused'), { code: 'ECONNREFUSED' })));
    await expect(connectToPrimary(3000, 'pk')).resolves.toBeNull();
  });

  it('resolves null when socket closes before handshake completes', async () => {
    const socket = makeSocket();
    mockConnect.mockImplementation((_o: unknown, cb: () => void) => {
      setImmediate(() => cb());
      return socket;
    });
    setImmediate(() => socket.emit('close'));
    await expect(connectToPrimary(3000, 'pk')).resolves.toBeNull();
  });

  it('invokes onPrimaryDisconnect when peer closes after handshake', async () => {
    const socket = makeSocket();
    mockConnect.mockImplementation((_o: unknown, cb: () => void) => {
      setImmediate(() => cb());
      return socket;
    });
    const cb = jest.fn();
    onPrimaryDisconnect(cb);
    setImmediate(() => socket.emit('data', Buffer.from('{"statsPort":55}\n')));
    await connectToPrimary(3000, 'pk');
    socket.emit('close');
    expect(cb).toHaveBeenCalled();
  });
});
