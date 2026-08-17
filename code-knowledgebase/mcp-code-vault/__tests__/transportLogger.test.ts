/**
 * createLoggingStdioTransport: onclose / onmessage branches (getShutdownOnTransportClose, getMethod).
 */

type InnerTransport = {
  onclose?: () => void;
  onerror?: (e: Error) => void;
  onmessage?: (msg: unknown) => void;
  start: jest.Mock;
  send: jest.Mock;
  close: jest.Mock;
};

let lastInner: InnerTransport;

jest.mock('@modelcontextprotocol/sdk/server/stdio', () => ({
  StdioServerTransport: jest.fn().mockImplementation(() => {
    lastInner = {
      start: jest.fn().mockResolvedValue(undefined),
      send: jest.fn(),
      close: jest.fn()
    };
    return lastInner;
  })
}));

const mockDisconnect = jest.fn();
const mockRunShutdown = jest.fn().mockResolvedValue(undefined);
const mockGetShutdownOnTransportClose = jest.fn();
const mockAppendRequestLog = jest.fn();

jest.mock('../src/shutdown', () => ({
  runShutdown: (...a: unknown[]) => mockRunShutdown(...a),
  getShutdownOnTransportClose: () => mockGetShutdownOnTransportClose()
}));

jest.mock('../src/primaryClient', () => ({
  disconnectFromPrimary: (...a: unknown[]) => mockDisconnect(...a)
}));

jest.mock('../src/mcp/requestLog', () => ({
  appendRequestLog: (...a: unknown[]) => mockAppendRequestLog(...a)
}));

import { createLoggingStdioTransport } from '../src/mcp/transportLogger';

describe('transportLogger createLoggingStdioTransport', () => {
  beforeEach(() => {
    mockDisconnect.mockClear();
    mockRunShutdown.mockClear();
    mockGetShutdownOnTransportClose.mockReturnValue(false);
    mockAppendRequestLog.mockClear();
  });

  it('getMethod returns unknown when method missing', () => {
    const t = createLoggingStdioTransport();
    t.onmessage = jest.fn();
    lastInner.onmessage!({ jsonrpc: '2.0', id: 1 });
    expect(mockAppendRequestLog).toHaveBeenCalledWith('unknown');
  });

  it('onclose runs disconnect and shutdown when getShutdownOnTransportClose is true', () => {
    mockGetShutdownOnTransportClose.mockReturnValue(true);
    const t = createLoggingStdioTransport();
    const userClose = jest.fn();
    t.onclose = userClose;
    lastInner.onclose!();
    expect(mockDisconnect).toHaveBeenCalled();
    expect(userClose).toHaveBeenCalled();
    expect(mockRunShutdown).toHaveBeenCalled();
  });

  it('onclose skips disconnect when getShutdownOnTransportClose is false', () => {
    mockGetShutdownOnTransportClose.mockReturnValue(false);
    const t = createLoggingStdioTransport();
    const userClose = jest.fn();
    t.onclose = userClose;
    lastInner.onclose!();
    expect(mockDisconnect).not.toHaveBeenCalled();
    expect(userClose).toHaveBeenCalled();
    expect(mockRunShutdown).not.toHaveBeenCalled();
  });

  it('onmessage wrapper logs method then calls handler', () => {
    const t = createLoggingStdioTransport();
    const innerHandler = jest.fn();
    t.onmessage = innerHandler;
    const msg = { jsonrpc: '2.0', method: 'tools/call', id: 1 };
    lastInner.onmessage!(msg);
    expect(mockAppendRequestLog).toHaveBeenCalledWith('tools/call');
    expect(innerHandler).toHaveBeenCalledWith(msg);
  });

  it('delegates start, send, close to inner transport', async () => {
    const t = createLoggingStdioTransport();
    await t.start();
    expect(lastInner.start).toHaveBeenCalled();
    const m = { jsonrpc: '2.0' as const, id: 1, result: {} };
    t.send(m as never);
    expect(lastInner.send).toHaveBeenCalledWith(m);
    t.close();
    expect(lastInner.close).toHaveBeenCalled();
  });
});
