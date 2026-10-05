import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildPalette,
  buildThemeVars,
  resolveInitialMode,
  hasExplicitChoice,
  setMode,
  initTheme,
  THEME_STORAGE_KEY,
  type ThemeMode,
} from './themeEngine'

/** WCAG 2.1 relative luminance from a #rrggbb string. */
function luminance(hex: string): number {
  const v = hex.replace('#', '')
  const ch = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255)
  const [r, g, b] = ch.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.1 contrast ratio between two #rrggbb strings. */
function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

const MODES: ThemeMode[] = ['light', 'dark', 'amoled']

describe('themeEngine palette generation', () => {
  it('resolves every declared role to a concrete hex value', () => {
    const { argb } = buildPalette('dark')
    const roles = Object.keys(argb)
    expect(roles.length).toBeGreaterThanOrEqual(30)
    for (const role of roles) {
      const value = argb[role as keyof typeof argb]
      expect(Number.isInteger(value)).toBe(true)
      // Alpha is not part of any role we publish.
      expect(value >>> 0).toBe(value)
    }
  })

  it('produces light and dark palettes that differ', () => {
    const light = buildPalette('light')
    const dark = buildPalette('dark')
    expect(light.argb.primary).not.toBe(dark.argb.primary)
    expect(light.argb.surface).not.toBe(dark.argb.surface)
  })

  it('flattens the surface ramp to true black in AMOLED but keeps accents', () => {
    const dark = buildPalette('dark')
    const amoled = buildPalette('amoled')
    expect(amoled.argb.surface).toBe(0xff000000)
    expect(amoled.argb.surface).not.toBe(dark.argb.surface)
    // Accent roles are unaffected by the surface override.
    expect(amoled.argb.primary).toBe(dark.argb.primary)
  })

  it('meets WCAG AA for on-colour pairs in every mode', () => {
    const pairs: [keyof ReturnType<typeof buildThemeVars>, string][] = [
      ['--md-sys-color-on-primary', '--md-sys-color-primary'],
      ['--md-sys-color-on-secondary', '--md-sys-color-secondary'],
      ['--md-sys-color-on-tertiary', '--md-sys-color-tertiary'],
      ['--md-sys-color-on-surface', '--md-sys-color-surface'],
      ['--md-sys-color-on-error', '--md-sys-color-error'],
    ]
    for (const mode of MODES) {
      const vars = buildThemeVars(mode)
      for (const [fg, bg] of pairs) {
        const ratio = contrast(vars[fg], vars[bg])
        // 4.5:1 is the WCAG AA threshold for normal-size body text.
        expect(
          ratio,
          `${mode} ${fg} on ${bg} was ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('emits canonical, legacy and RGB-channel twins for every role', () => {
    const vars = buildThemeVars('dark')
    expect(vars['--md-sys-color-primary']).toMatch(/^#[0-9a-f]{6}$/)
    // Legacy alias Tailwind and src/index.css already depend on.
    expect(vars['--md-primary']).toBe(vars['--md-sys-color-primary'])
    // Channel twin, for Tailwind opacity modifiers like bg-primary/40.
    expect(vars['--md-primary-rgb']).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/)
    expect(vars['--md-surface-container-high-rgb']).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/)
  })

  it('sets color-scheme to match the mode', () => {
    expect(buildThemeVars('light')['color-scheme']).toBe('light')
    expect(buildThemeVars('dark')['color-scheme']).toBe('dark')
    expect(buildThemeVars('amoled')['color-scheme']).toBe('dark')
  })
})

describe('themeEngine preference handling', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('falls back to the OS preference when nothing is stored', () => {
    expect(hasExplicitChoice()).toBe(false)
    expect(['light', 'dark']).toContain(resolveInitialMode())
  })

  it('lets a stored user choice outrank the OS preference', () => {
    setMode('amoled')
    expect(hasExplicitChoice()).toBe(true)
    expect(resolveInitialMode()).toBe('amoled')
  })

  it('persists the choice and mirrors it onto the document element', () => {
    setMode('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(document.documentElement.style.getPropertyValue('--md-sys-color-primary')).toMatch(
      /^#[0-9a-f]{6}$/,
    )
  })

  it('initTheme writes the full palette to :root', () => {
    const mode = initTheme()
    const root = document.documentElement
    expect(['light', 'dark', 'amoled']).toContain(mode)
    expect(root.getAttribute('data-theme')).toBe(mode)
    expect(root.style.getPropertyValue('--md-sys-color-surface')).toMatch(/^#[0-9a-f]{6}$/)
    expect(root.style.getPropertyValue('--md-surface-container-rgb')).not.toBe('')
  })
})