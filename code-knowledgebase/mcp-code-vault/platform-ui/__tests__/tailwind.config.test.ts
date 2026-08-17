import { describe, it, expect } from 'vitest';
import config from '../tailwind.config';

describe('tailwind.config', () => {
  it('exports a valid Tailwind config with theme.extend', () => {
    expect(config).toBeDefined();
    expect(config.theme?.extend).toBeDefined();
  });

  it('defines surface, accent, and chart colors', () => {
    const { colors } = config.theme!.extend!;
    expect(colors?.surface).toEqual({
      DEFAULT: '#100B1A',
      card: '#1A1726',
      sidebar: '#0f0b14'
    });
    expect(colors?.accent).toEqual({
      DEFAULT: '#8B5CF6',
      hover: '#7C3AED',
      light: '#A78BFA'
    });
    expect(colors?.chart).toEqual({
      pink: '#EC4899',
      purple: '#8B5CF6',
      orange: '#F97316',
      blue: '#3B82F6'
    });
  });

  it('defines borderRadius.card and borderRadius.btn', () => {
    const { borderRadius } = config.theme!.extend!;
    expect(borderRadius?.card).toBe('0.75rem');
    expect(borderRadius?.btn).toBe('0.5rem');
  });

  it('defines boxShadow including card, glass-hover, and neon-cyan variants', () => {
    const { boxShadow } = config.theme!.extend!;
    expect(boxShadow?.card).toContain('rgb(0 0 0 / 0.2)');
    expect(boxShadow?.['glass-hover']).toContain('rgba(0,0,0,0.5)');
    expect(boxShadow?.['neon-cyan']).toBeDefined();
    expect(boxShadow?.['neon-cyan/10']).toBeDefined();
    expect(boxShadow?.['neon-cyan/20']).toBeDefined();
  });

  it('defines backgroundImage.noise URL', () => {
    const { backgroundImage } = config.theme!.extend!;
    expect(backgroundImage?.noise).toContain('noise.svg');
  });

  it('defines transitionDuration and transitionTimingFunction', () => {
    const { transitionDuration, transitionTimingFunction } = config.theme!.extend!;
    expect(transitionDuration?.['200']).toBe('200ms');
    expect(transitionDuration?.['300']).toBe('300ms');
    expect(transitionTimingFunction?.['out-expo']).toBe('cubic-bezier(0.4, 0, 0.2, 1)');
    expect(transitionTimingFunction?.['back-out']).toBe('cubic-bezier(0.34, 1.56, 0.64, 1)');
  });

  it('has empty plugins array', () => {
    expect(config.plugins).toEqual([]);
  });
});
