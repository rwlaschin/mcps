/**
 * Re-export so pages can `import('../lib/socketIoClient')` instead of `import('socket.io-client')`.
 * Dynamic imports of bare node_modules resolve to `/_nuxt/node_modules/...` in dev, which 404s.
 */
export { io } from 'socket.io-client'
