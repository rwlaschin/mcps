import { describe, expect, it } from 'vitest'
import { mongoIdString } from '../../lib/mongoId'

describe('mongoIdString', () => {
  it('returns trimmed string ids', () => {
    expect(mongoIdString(' 507f1f77bcf86cd799439011 ')).toBe('507f1f77bcf86cd799439011')
  })
  it('reads Extended JSON $oid', () => {
    expect(mongoIdString({ $oid: '507f1f77bcf86cd799439011' })).toBe('507f1f77bcf86cd799439011')
  })
  it('returns empty for null or empty object stringification', () => {
    expect(mongoIdString(null)).toBe('')
    expect(mongoIdString(undefined)).toBe('')
    expect(mongoIdString({})).toBe('')
  })
})
