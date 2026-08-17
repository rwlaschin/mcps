/**
 * Unit tests for primary client (onPrimaryDisconnect, disconnectFromPrimary).
 * connectToPrimary is covered by integration tests; here we cover the API that doesn't require a live server.
 */

import {
  onPrimaryDisconnect,
  disconnectFromPrimary
} from '../src/primaryClient';

describe('primaryClient', () => {
  describe('onPrimaryDisconnect', () => {
    it('registers a callback without throwing', () => {
      const cb = jest.fn();
      expect(() => onPrimaryDisconnect(cb)).not.toThrow();
    });
  });

  describe('disconnectFromPrimary', () => {
    it('clears connection and callback without throwing', () => {
      onPrimaryDisconnect(jest.fn());
      expect(() => disconnectFromPrimary()).not.toThrow();
    });

    it('is safe to call when never connected', () => {
      expect(() => disconnectFromPrimary()).not.toThrow();
    });
  });
});
