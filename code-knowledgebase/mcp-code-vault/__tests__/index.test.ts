jest.mock('os', () => ({
  networkInterfaces: jest.fn(() => ({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.10' }]
  }))
}));

// Simulate npm run dev (TTY): skip required-env check so tests don't need MCP_PROJECT_NAME/WORKING_DIRECTORY
jest.mock('../src/stdioMode', () => ({
  ...jest.requireActual('../src/stdioMode'),
  stdioMode: false
}));

jest.mock('../src/stats/server', () => ({ createStatsServer: jest.fn() }));
jest.mock('../src/mcp/server', () => ({
  createMcpServer: jest.fn().mockResolvedValue(undefined),
  getMcpServerInstance: jest.fn().mockReturnValue(null)
}));
jest.mock('../src/logger', () => ({ logger: { info: jest.fn(), fatal: jest.fn() } }));
jest.mock('../src/discoveryClient', () => ({
  startDiscoveryClient: jest.fn(),
  stopDiscoveryClient: jest.fn(),
  tryStartDiscoveryAsPrimary: jest.fn().mockResolvedValue(true),
  startPrimaryAnnouncer: jest.fn(),
  discoverPrimary: jest.fn().mockResolvedValue(null)
}));
jest.mock('../src/primaryServer', () => ({
  startPrimaryServer: jest.fn(),
  stopPrimaryServer: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../src/primaryClient', () => ({
  connectToPrimary: jest.fn(),
  onPrimaryDisconnect: jest.fn(),
  disconnectFromPrimary: jest.fn()
}));
jest.mock('../src/stats/metricsClient', () => {
  const actual = jest.requireActual('../src/stats/metricsClient');
  return {
    ...actual,
    setStatsBaseUrl: jest.fn(),
    markServerReady: jest.fn()
  };
});
const createStatsServer = require('../src/stats/server').createStatsServer;
const createMcpServer = require('../src/mcp/server').createMcpServer;
const { logger } = require('../src/logger');
const discoveryClient = require('../src/discoveryClient');
const primaryServer = require('../src/primaryServer');
const primaryClient = require('../src/primaryClient');
const metricsClient = require('../src/stats/metricsClient');

const { main, localNetworkHost, __resetProcessInstanceIdForTest } = require('../src/index');

let stderrWriteSpy: jest.SpyInstance;

describe('index', () => {
  beforeEach(() => {
    stderrWriteSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    __resetProcessInstanceIdForTest();
  });
  afterEach(() => {
    stderrWriteSpy?.mockRestore();
  });

  describe('localNetworkHost', () => {
    it('returns first IPv4 non-internal address or null', () => {
      const result = localNetworkHost();
      expect(result).toBe('192.168.1.10');
    });
    it('returns null when no external IPv4', () => {
      const os = require('os');
      os.networkInterfaces.mockReturnValueOnce({
        lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }]
      });
      const r = localNetworkHost();
      expect(r).toBe(null);
    });
  });

  describe('main', () => {
    it('throws when PORT is invalid (e.g. negative)', async () => {
      const origPort = process.env.PORT;
      process.env.PORT = '-1';
      try {
        await expect(main()).rejects.toThrow('PORT must be a non-negative integer');
      } finally {
        if (origPort !== undefined) process.env.PORT = origPort;
        else delete process.env.PORT;
      }
    });

    it('second main() is a no-op after first successful init', async () => {
      const mockListen = jest.fn().mockResolvedValue(undefined);
      createStatsServer.mockResolvedValue({ server: {}, listen: mockListen });
      const origPort = process.env.PORT;
      const origMongo = process.env.MONGO_URL;
      process.env.PORT = '3998';
      process.env.MONGO_URL = 'mongodb://localhost:27017/test';
      try {
        await main();
        stderrWriteSpy.mockClear();
        await main();
        expect(String(stderrWriteSpy.mock.calls.map((c) => c[0]).join(''))).toContain('Already initialized');
      } finally {
        process.env.PORT = origPort;
        if (origMongo !== undefined) process.env.MONGO_URL = origMongo;
        else delete process.env.MONGO_URL;
      }
    });

    it('sets context, creates MCP server, then stats server and listens', async () => {
      const mockListen = jest.fn().mockResolvedValue(undefined);
      createStatsServer.mockResolvedValue({ server: {}, listen: mockListen });

      const origPort = process.env.PORT;
      const origMongo = process.env.MONGO_URL;
      process.env.PORT = '3999';
      process.env.MONGO_URL = 'mongodb://localhost:27017/test'; // so stats server is started (not MCP-only skip)
      try {
        await main();
      } finally {
        process.env.PORT = origPort;
        if (origMongo !== undefined) process.env.MONGO_URL = origMongo;
        else delete process.env.MONGO_URL;
      }

      expect(discoveryClient.tryStartDiscoveryAsPrimary).toHaveBeenCalledWith(3999);
      expect(createStatsServer).toHaveBeenCalled();
      expect(mockListen).toHaveBeenCalledWith({ port: 3999, host: '0.0.0.0' });
      expect(discoveryClient.startDiscoveryClient).toHaveBeenCalledWith(3999, 'mcp-3999');
      expect(primaryServer.startPrimaryServer).toHaveBeenCalledWith(3999);
      expect(logger.info).toHaveBeenCalled();
      expect(createMcpServer).toHaveBeenCalled();
    });

    it('when tryStartDiscoveryAsPrimary returns false and connectToPrimary succeeds, runs as client: setStatsBaseUrl, markServerReady(client), no stats server', async () => {
      createStatsServer.mockClear();
      primaryServer.startPrimaryServer.mockClear();
      discoveryClient.startDiscoveryClient.mockClear();
      discoveryClient.tryStartDiscoveryAsPrimary.mockResolvedValueOnce(false);
      primaryClient.connectToPrimary.mockResolvedValueOnce({ statsPort: 3999 });

      const origPort = process.env.PORT;
      process.env.PORT = '3999';
      try {
        await main();
      } finally {
        process.env.PORT = origPort;
      }

      expect(discoveryClient.tryStartDiscoveryAsPrimary).toHaveBeenCalledWith(3999);
      expect(primaryClient.connectToPrimary).toHaveBeenCalledWith(3999, expect.any(String), undefined);
      expect(metricsClient.setStatsBaseUrl).toHaveBeenCalledWith('http://127.0.0.1:3999');
      expect(metricsClient.markServerReady).toHaveBeenCalledWith('client');
      expect(createStatsServer).not.toHaveBeenCalled();
      expect(primaryServer.startPrimaryServer).not.toHaveBeenCalled();
      expect(discoveryClient.startDiscoveryClient).not.toHaveBeenCalled();
    });

    it('when tryStartDiscoveryAsPrimary returns false, registers disconnectFromPrimary for shutdown', async () => {
      discoveryClient.tryStartDiscoveryAsPrimary.mockResolvedValueOnce(false);
      primaryClient.connectToPrimary.mockResolvedValueOnce({ statsPort: 4000 });

      const { registerShutdown } = require('../src/shutdown');
      const shutdownSpy = jest.spyOn(require('../src/shutdown'), 'registerShutdown');

      const origPort = process.env.PORT;
      process.env.PORT = '3999';
      try {
        await main();
        expect(shutdownSpy).toHaveBeenCalledWith(primaryClient.disconnectFromPrimary);
      } finally {
        process.env.PORT = origPort;
        shutdownSpy.mockRestore();
      }
    });
  });
});
