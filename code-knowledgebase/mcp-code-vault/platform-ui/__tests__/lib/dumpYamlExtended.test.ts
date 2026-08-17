import { describe, expect, it } from 'vitest'
import { dumpYamlExtended } from '../../lib/dumpYamlExtended'

describe('dumpYamlExtended', () => {
  it('serializes short scalars inline', () => {
    expect(dumpYamlExtended({ a: 1, b: true, c: null })).toContain('a: 1')
    expect(dumpYamlExtended({ a: 1, b: true, c: null })).toContain('b: true')
    expect(dumpYamlExtended({ a: 1, b: true, c: null })).toContain('c: null')
  })

  it('uses block scalar for long strings', () => {
    const long = 'x'.repeat(100)
    const out = dumpYamlExtended({ instructions: long })
    expect(out).toContain('instructions:')
    expect(out).toContain('|')
    expect(out).toContain(long)
  })

  it('serializes array of objects with list items', () => {
    const out = dumpYamlExtended([{ a: 1 }, { b: 2 }])
    expect(out).toMatch(/^-/)
    expect(out).toContain('a: 1')
    expect(out).toContain('b: 2')
  })

  it('handles nested objects, arrays on keys, non-finite numbers, and odd keys', () => {
    const out = dumpYamlExtended({
      'not plain': { inner: 1 },
      list: [[1, 2]],
      n: Number.NaN,
      empty: []
    })
    expect(out).toContain('n: null')
    expect(out).toContain('inner: 1')
    expect(out).toContain('list:')
    expect(out).toContain('empty:')
    expect(out).toContain('[]')
  })

  it('serializes nested array items under a list entry', () => {
    const out = dumpYamlExtended([['a', 'b']])
    expect(out).toContain('- ')
    expect(out).toContain('"a"')
  })

  it('strips leading indent for top-level scalar', () => {
    expect(dumpYamlExtended('hi')).toBe('"hi"')
  })

  it('handles top-level symbol via serialize fallback', () => {
    expect(dumpYamlExtended(Symbol('x'))).toContain('Symbol')
  })
})
