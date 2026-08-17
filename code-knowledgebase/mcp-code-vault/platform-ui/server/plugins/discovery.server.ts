/**
 * Discovery broadcast: periodically send UDP datagram to 255.255.255.255:9255
 * with this UI's register URL so MCP servers can POST to /api/register.
 */
import dgram from 'node:dgram'
import os from 'node:os'

const DISCOVERY_PORT = 9255
const BROADCAST_INTERVAL_MS = 5000

/** Host to advertise in the discovery broadcast. UI dev server defaults to 0.0.0.0 so this URL is reachable. */
function getRegisterHost(): string {
  const envHost = process.env.NUXT_HOST || process.env.NITRO_HOST
  if (envHost && envHost !== '') return envHost
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return '127.0.0.1'
}

export default defineNitroPlugin(() => {
  if (process.env.NODE_ENV === 'test') return

  const port = Number(process.env.NITRO_PORT || process.env.NUXT_PORT || 2999)
  const host = getRegisterHost()
  const registerUrl = `http://${host}:${port}/api/register`
  console.info(`[discovery] Broadcasting registerUrl=${registerUrl} (backends must be able to reach this)`)

  const socket = dgram.createSocket('udp4')
  socket.on('error', (err) => {
    console.error('[discovery] UDP error:', err)
  })
  socket.bind(0, () => {
    socket.setBroadcast(true)
    const send = () => {
      const payload = JSON.stringify({ registerUrl })
      const buf = Buffer.from(payload, 'utf8')
      /** Same-host discovery (always works; MCP listens on 0.0.0.0:9255). */
      socket.send(buf, 0, buf.length, DISCOVERY_PORT, '127.0.0.1', (err) => {
        if (err) console.error('[discovery] loopback send error:', err)
      })
      /** LAN broadcast — often fails with ENETUNREACH (VPN, no default route, etc.); ignore that case. */
      socket.send(buf, 0, buf.length, DISCOVERY_PORT, '255.255.255.255', (err) => {
        if (err && (err as NodeJS.ErrnoException).code !== 'ENETUNREACH') {
          console.error('[discovery] broadcast send error:', err)
        }
      })
    }
    send()
    const interval = setInterval(send, BROADCAST_INTERVAL_MS)
    // Keep process from exiting; Nitro doesn't hold the socket ref
    const noop = () => {}
    socket.ref()
    // Clear interval when Nitro closes (no formal hook; interval runs until process exit)
    ;(socket as unknown as { _discoveryInterval?: ReturnType<typeof setInterval> })._discoveryInterval = interval
  })
})
