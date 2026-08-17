/** Browser stub for the "debug" package (used by socket.io-client). Exposes a default export for ESM. */
function noop() {}
function createDebug() {
  return noop;
}
createDebug.enable = noop;
createDebug.disable = noop;
export default createDebug;
