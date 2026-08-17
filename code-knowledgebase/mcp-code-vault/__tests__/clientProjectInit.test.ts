/**
 * Ensures the MCP "client" (secondary startup path) initializes the Project in DB.
 * We only run this initialization when running in real MCP transport mode (stdioMode=true),
 * and unit tests should mock stdioMode explicitly.
 */

jest.mock('os', () => ({
  networkInterfaces: jest.fn(() => ({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.10' }]
  }))
}));

jest.mock('../src/stdioMode', () => ({
  ...jest.requireActual('../src/stdioMode'),
  stdioMode: true
}));

const mockConnectMongoose = jest.fn().mockResolvedValue(undefined);
const mockDisconnectMongoose = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/db/mongoose', () => ({
  connectMongoose: (...args: unknown[]) => mockConnectMongoose(...args),
  disconnectMongoose: (...args: unknown[]) => mockDisconnectMongoose(...args)
}));

const mockRunSeed = jest.fn().mockResolvedValue('skipped' as const);
const mockEnsurePromptsFromSeed = jest.fn().mockResolvedValue('skipped' as const);
jest.mock('../src/db/seed', () => ({
  runSeed: (...args: unknown[]) => mockRunSeed(...args),
  ensurePromptsFromSeed: (...args: unknown[]) => mockEnsurePromptsFromSeed(...args)
}));

const mockEnsureProjectFromConfig = jest.fn().mockResolvedValue('unchanged');
jest.mock('../src/db/ensureProject', () => ({
  ensureProjectFromConfig: (...args: unknown[]) => mockEnsureProjectFromConfig(...args)
}));

jest.mock('../src/db/projectDb', () => ({
  ...jest.requireActual('../src/db/projectDb'),
  ensureProjectCollections: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../src/fileProcessingStartup', () => ({
  runFileProcessingStartup: jest.fn().mockResolvedValue(undefined)
}));

const mockPushToStream = jest.fn();
jest.mock('../src/stats/streamChannel', () => ({
  ...jest.requireActual('../src/stats/streamChannel'),
  pushToStream: (...args: unknown[]) => mockPushToStream(...args)
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
  tryStartDiscoveryAsPrimary: jest.fn().mockResolvedValue(false),
  startPrimaryAnnouncer: jest.fn(),
  discoverPrimary: jest.fn().mockResolvedValue({ host: '127.0.0.1', tcpPort: 9256 })
}));

jest.mock('../src/primaryServer', () => ({
  startPrimaryServer: jest.fn(),
  stopPrimaryServer: jest.fn()
}));

const mockConnectToPrimary = jest.fn().mockResolvedValue({ statsPort: 3999 });
jest.mock('../src/primaryClient', () => ({
  connectToPrimary: (...args: unknown[]) => mockConnectToPrimary(...args),
  disconnectFromPrimary: jest.fn(),
  onPrimaryDisconnect: jest.fn()
}));

const mockPostMetric = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/stats/metricsClient', () => {
  const actual = jest.requireActual('../src/stats/metricsClient');
  return {
    ...actual,
    postMetric: (...args: unknown[]) => mockPostMetric(...args),
    setStatsBaseUrl: jest.fn(),
    markServerReady: jest.fn()
  };
});

const primaryClient = require('../src/primaryClient');

// Import after mocks
const { main, __resetProcessInstanceIdForTest } = require('../src/index');
const discoveryClient = require('../src/discoveryClient');

describe('clientProjectInit (MCP stdio mode)', () => {
  beforeEach(() => {
    __resetProcessInstanceIdForTest();
    mockConnectMongoose.mockClear();
    mockDisconnectMongoose.mockClear();
    mockRunSeed.mockClear();
    mockEnsurePromptsFromSeed.mockClear();
    mockEnsureProjectFromConfig.mockClear();
    mockConnectToPrimary.mockClear();
    mockPushToStream.mockClear();
    mockPostMetric.mockClear();

    process.env.MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017';
    process.env.MCP_PROJECT_NAME = 'my-project';
    process.env.WORKING_DIRECTORY = '/tmp/my-workdir';
    process.env.PORT = '3100';
  });

  it('connects to primary, then ensures Project in DB', async () => {
    await main();

    expect(discoveryClient.tryStartDiscoveryAsPrimary).toHaveBeenCalled();
    expect(mockConnectToPrimary).toHaveBeenCalled();
    expect(mockConnectMongoose).toHaveBeenCalled();
    expect(mockRunSeed).toHaveBeenCalled();
    expect(mockEnsurePromptsFromSeed).toHaveBeenCalled();
    expect(mockEnsureProjectFromConfig).toHaveBeenCalledWith(
      'my-project',
      expect.any(String)
    );
    expect(mockPushToStream).toHaveBeenCalledWith(
      'db:connected',
      expect.stringContaining('"source":"client"')
    );
    expect(mockPushToStream).toHaveBeenCalledWith(
      'seed:checked',
      expect.stringMatching(/"action":"(ran|skipped)"/)
    );
    expect(mockPushToStream).toHaveBeenCalledWith(
      'project',
      expect.stringContaining('"source":"client"')
    );
  });

  it('does not post init metric (primary records it; avoids duplicate)', async () => {
    await main();
    const initCalls = mockPostMetric.mock.calls.filter(
      (c) => (c[0] as { operation?: string })?.operation === 'init'
    );
    expect(initCalls).toHaveLength(0);
  });
});

export {};

