/**
 * logFile: getLogPath, ensureLogDir, appendLine.
 * Tests written to define expected behaviour (TDD-style).
 */
const pathLib = require('path') as { join: (...a: string[]) => string; dirname: (p: string) => string };
const fs = require('fs');

const { getLogPath, ensureLogDir, appendLine, closeLogFile } = require('../src/logFile');

describe('logFile', () => {
  const cwd = process.cwd();

  describe('getLogPath', () => {
    it('returns path under process.cwd()/logs/mcp-code-vault.log', () => {
      const p = getLogPath();
      expect(p).toBe(pathLib.join(cwd, 'logs', 'mcp-code-vault.log'));
    });
    it('returns the same path on repeated calls', () => {
      expect(getLogPath()).toBe(getLogPath());
    });
  });

  describe('ensureLogDir', () => {
    it('creates logs directory when missing', () => {
      const mkdirSync = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
      ensureLogDir();
      expect(mkdirSync).toHaveBeenCalledWith(pathLib.join(cwd, 'logs'), { recursive: true });
      mkdirSync.mockRestore();
    });
    it('does not throw when mkdirSync throws', () => {
      const mkdirSync = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => { throw new Error('EACCES'); });
      expect(() => ensureLogDir()).not.toThrow();
      mkdirSync.mockRestore();
    });
  });

  describe('appendLine', () => {
    it('writes message to stream', () => {
      const write = jest.fn();
      jest.spyOn(fs, 'createWriteStream').mockReturnValue({ write });
      const origNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = '';
      try {
        appendLine('hello\n');
        expect(write).toHaveBeenCalled();
        expect(write.mock.calls[0][0]).toContain('hello\n');
      } finally {
        process.env.NODE_ENV = origNodeEnv;
        closeLogFile();
        jest.restoreAllMocks();
      }
    });
    it('does not throw when write throws', () => {
      jest.spyOn(fs, 'createWriteStream').mockReturnValue({
        write: () => { throw new Error('ENOSPC'); }
      });
      expect(() => appendLine('x')).not.toThrow();
      closeLogFile();
      jest.restoreAllMocks();
    });
  });
});
