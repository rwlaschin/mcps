const { appendRequestLog } = require('../src/mcp/requestLog');

describe('requestLog', () => {
  it('appendRequestLog does not throw and writes to logs/mcp-requests.log when writable', () => {
    expect(() => {
      appendRequestLog('initialize');
      appendRequestLog('tools/list');
    }).not.toThrow();
    const path = require('path');
    const fs = require('fs');
    const requestLogPath = path.join(process.cwd(), 'logs', 'mcp-requests.log');
    if (fs.existsSync(requestLogPath)) {
      const content = fs.readFileSync(requestLogPath, 'utf8');
      expect(content).toContain('[MCP] request initialize');
      expect(content).toContain('[MCP] request tools/list');
    }
  });
});
