/**
 * stdioMode: stdioMode flag, setProcessLogSink, writeProcessLog.
 * Tests define expected behaviour (TDD-style).
 */
describe('stdioMode', () => {
  const origEnv = process.env.MCP_STDIO;
  let stdoutIsTTY: boolean | undefined;

  beforeAll(() => {
    stdoutIsTTY = process.stdout.isTTY;
  });

  afterEach(() => {
    process.env.MCP_STDIO = origEnv;
    if (process.stdout.isTTY !== stdoutIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', { value: stdoutIsTTY, configurable: true });
    }
  });

  describe('stdioMode constant', () => {
    it('is true when isTTY is not true (piped/undefined)', () => {
      jest.isolateModules(() => {
        Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
        delete process.env.MCP_STDIO;
        const { stdioMode } = require('../src/stdioMode');
        expect(stdioMode).toBe(true);
      });
    });
    it('is false when isTTY is true and MCP_STDIO is not 1', () => {
      jest.isolateModules(() => {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        delete process.env.MCP_STDIO;
        const { stdioMode } = require('../src/stdioMode');
        expect(stdioMode).toBe(false);
      });
    });
    it('is false when MCP_STDIO is 0 (force non-MCP even if isTTY false)', () => {
      jest.isolateModules(() => {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        process.env.MCP_STDIO = '0';
        const { stdioMode } = require('../src/stdioMode');
        expect(stdioMode).toBe(false);
      });
    });
  });

  describe('setProcessLogSink, addProcessLogSink and writeProcessLog', () => {
    it('writeProcessLog calls sink when sink is set (stdio mode or not; we only avoid stdout/stderr)', () => {
      jest.isolateModules(() => {
        const { setProcessLogSink, writeProcessLog } = require('../src/stdioMode');
        const sink = jest.fn();
        setProcessLogSink(sink);
        writeProcessLog('msg');
        expect(sink).toHaveBeenCalledWith('msg');
      });
    });
    it('writeProcessLog calls all sinks (setProcessLogSink + addProcessLogSink)', () => {
      jest.isolateModules(() => {
        const { setProcessLogSink, addProcessLogSink, writeProcessLog } = require('../src/stdioMode');
        const file = jest.fn();
        const stderr = jest.fn();
        setProcessLogSink(file);
        addProcessLogSink(stderr);
        writeProcessLog('line\n');
        expect(file).toHaveBeenCalledWith('line\n');
        expect(stderr).toHaveBeenCalledWith('line\n');
      });
    });
  });
});
