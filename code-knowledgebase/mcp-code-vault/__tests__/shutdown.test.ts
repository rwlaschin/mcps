const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);

describe('shutdown', () => {
  afterEach(() => {
    exitSpy.mockClear();
  });

  afterAll(() => {
    exitSpy.mockRestore();
  });

  describe('setShutdownOnTransportClose and getShutdownOnTransportClose', () => {
    it('getShutdownOnTransportClose returns value set by setShutdownOnTransportClose', () => {
      jest.isolateModules(() => {
        const {
          setShutdownOnTransportClose,
          getShutdownOnTransportClose
        } = require('../src/shutdown');
        expect(getShutdownOnTransportClose()).toBe(false);
        setShutdownOnTransportClose(true);
        expect(getShutdownOnTransportClose()).toBe(true);
        setShutdownOnTransportClose(false);
        expect(getShutdownOnTransportClose()).toBe(false);
      });
    });
  });

  describe('registerShutdown', () => {
    it('registers a sync hook', () => {
      const { registerShutdown } = require('../src/shutdown');
      const fn = jest.fn();
      registerShutdown(fn);
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('runShutdown', () => {
    it('runs registered hooks and then exits', async () => {
      await new Promise<void>((resolve, reject) => {
        jest.isolateModules(() => {
          const { registerShutdown, runShutdown } = require('../src/shutdown');
          const fn = jest.fn();
          registerShutdown(fn);
          runShutdown()
            .then(() => {
              expect(fn).toHaveBeenCalledTimes(1);
              expect(exitSpy).toHaveBeenCalledWith(0);
              resolve();
            })
            .catch(reject);
        });
      });
    });

    it('runs async hooks', async () => {
      await new Promise<void>((resolve, reject) => {
        jest.isolateModules(() => {
          const { registerShutdown, runShutdown } = require('../src/shutdown');
          const fn = jest.fn().mockResolvedValue(undefined);
          registerShutdown(fn);
          runShutdown()
            .then(() => {
              expect(fn).toHaveBeenCalled();
              expect(exitSpy).toHaveBeenCalledWith(0);
              resolve();
            })
            .catch(reject);
        });
      });
    });

    it('continues with other hooks if one throws', async () => {
      await new Promise<void>((resolve, reject) => {
        jest.isolateModules(() => {
          const { registerShutdown, runShutdown } = require('../src/shutdown');
          const good = jest.fn();
          const bad = jest.fn().mockRejectedValue(new Error('hook failed'));
          registerShutdown(bad);
          registerShutdown(good);
          runShutdown()
            .then(() => {
              expect(bad).toHaveBeenCalled();
              expect(good).toHaveBeenCalled();
              expect(exitSpy).toHaveBeenCalledWith(0);
              resolve();
            })
            .catch(reject);
        });
      });
    });
  });
});
