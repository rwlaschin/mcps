import { describe, it, expect, vi } from 'vitest'

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({}))
}))

import { io } from '../../lib/socketIoClient'

describe('socketIoClient', () => {
  it('re-exports io from socket.io-client', () => {
    expect(typeof io).toBe('function')
  })
})
