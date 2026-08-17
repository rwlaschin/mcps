import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.stubGlobal('defineNitroPlugin', (fn: () => void) => {
  fn()
  return fn
})

const hoisted = vi.hoisted(() => {
  const mockSocket = {
    on: vi.fn(),
    bind: vi.fn((_p: number, cb: () => void) => {
      cb()
    }),
    setBroadcast: vi.fn(),
    send: vi.fn(
      (_b: Buffer, _o: number, _l: number, _port: number, _host: string, cb?: (err?: Error | null) => void) => {
        cb?.(null)
      }
    ),
    ref: vi.fn(),
  }
  const createSocket = vi.fn(() => mockSocket)
  return { mockSocket, createSocket }
})

vi.mock('node:dgram', () => ({
  default: {
    createSocket: hoisted.createSocket,
  },
}))

describe('server/plugins/discovery.server', () => {
  const prevEnv = { NODE_ENV: process.env.NODE_ENV, NITRO_PORT: process.env.NITRO_PORT }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.createSocket.mockClear()
    hoisted.mockSocket.bind.mockImplementation((_p: number, cb: () => void) => {
      cb()
    })
    hoisted.mockSocket.send.mockImplementation(
      (_b: Buffer, _o: number, _l: number, _port: number, _host: string, cb?: (err?: Error | null) => void) => {
        cb?.(null)
      }
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.resetModules()
    process.env.NODE_ENV = prevEnv.NODE_ENV
    if (prevEnv.NITRO_PORT !== undefined) process.env.NITRO_PORT = prevEnv.NITRO_PORT
    else delete process.env.NITRO_PORT
  })

  it('creates UDP socket and sends discovery payload when NODE_ENV is not test', async () => {
    process.env.NODE_ENV = 'development'
    process.env.NITRO_PORT = '3199'
    await import('../../../server/plugins/discovery.server')
    expect(hoisted.createSocket).toHaveBeenCalledWith('udp4')
    expect(hoisted.mockSocket.bind).toHaveBeenCalled()
    expect(hoisted.mockSocket.send).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6000)
    expect(hoisted.mockSocket.send.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
