/**
 * run.ts is the dev entry wrapper; we exercise it so it gets coverage without excluding.
 */
const mockMain = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/index.ts', () => ({
  main: (...args: unknown[]) => mockMain(...args)
}));

describe('run.ts', () => {
  it('loads index and calls main().catch(onFatal)', async () => {
    require('../src/run.ts');
    await Promise.resolve(); // let main() promise settle
    expect(mockMain).toHaveBeenCalled();
  });

  it('onFatal: on load error writes to stderr and exits', () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const writeSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    jest.resetModules();
    jest.doMock('../src/index.ts', () => {
      throw new Error('load fail');
    });
    try {
      require('../src/run.ts');
    } catch {
      // may throw or exit
    }

    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('[mcp] FATAL'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  });
});
