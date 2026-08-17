import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  isConfigPath,
  configHashFragment,
  normalizeConfigSectionHash
} from '../../composables/useConfigRoute'

describe('isConfigPath', () => {
  it('treats /config and /config/ as config page', () => {
    expect(isConfigPath('/config')).toBe(true)
    expect(isConfigPath('/config/')).toBe(true)
    expect(isConfigPath('/config///')).toBe(true)
  })

  it('rejects other paths', () => {
    expect(isConfigPath('/')).toBe(false)
    expect(isConfigPath('/config/extra')).toBe(false)
    expect(isConfigPath('/docs')).toBe(false)
  })
})

describe('configHashFragment', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prefers vue-router hash when set', () => {
    expect(configHashFragment('/config', '#prompts-personas')).toBe('prompts-personas')
  })

  it('falls back to window.location.hash when route hash is empty on /config', () => {
    vi.stubGlobal('window', {
      location: { hash: '#prompts-personas' }
    })
    expect(configHashFragment('/config', '')).toBe('prompts-personas')
  })

  it('returns empty for non-config path even if window has a hash', () => {
    vi.stubGlobal('window', {
      location: { hash: '#prompts-personas' }
    })
    expect(configHashFragment('/docs', '')).toBe('')
  })
})

describe('normalizeConfigSectionHash', () => {
  it('maps legacy aliases to canonical ids', () => {
    expect(normalizeConfigSectionHash('personas')).toBe('prompts-personas')
    expect(normalizeConfigSectionHash('prompts')).toBe('prompts-global')
    expect(normalizeConfigSectionHash('project-config')).toBe('settings')
  })

  it('defaults unknown fragments to settings', () => {
    expect(normalizeConfigSectionHash('nope')).toBe('settings')
    expect(normalizeConfigSectionHash('')).toBe('settings')
  })
})
