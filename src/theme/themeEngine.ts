/**
 * Campus Plug — Material 3 theme engine.
 *
 * Generates the full HCT tonal palette from the single seed colour declared in
 * `theme.tokens.json` and publishes it to `:root` as CSS custom properties.
 *
 * Every role is emitted three ways so that the existing token consumers keep
 * working without a rewrite:
 *
 *   --md-sys-color-<role>       canonical Material 3 name
 *   --md-<role>                 legacy alias consumed by src/index.css
 *   --md-<role>-rgb             bare RGB channels, so Tailwind can inject alpha
 *
 * The library's `Scheme` class is deprecated; this uses `SchemeTonalSpot`
 * (a `DynamicScheme`) with `MaterialDynamicColors`, which is the supported path.
 */

import {
  MaterialDynamicColors,
  SchemeTonalSpot,
  Hct,
  argbFromHex,
  hexFromArgb,
} from '@material/material-color-utilities'
// `DynamicScheme` is re-exported from the package root. Subpath imports do not
// resolve: the package's "exports" map only declares ".", so importing
// "@material/material-color-utilities/dynamiccolor/dynamic_scheme" fails at
// bundle time.
import type { DynamicScheme } from '@material/material-color-utilities'
import tokens from './theme.tokens.json'

export type ThemeMode = 'light' | 'dark' | 'amoled'

export const THEME_STORAGE_KEY = 'cp_theme'

/**
 * DynamicColor accessor for each role we publish.
 *
 * These are *instance* methods on `MaterialDynamicColors`. The class also
 * carries deprecated `static` properties of the same names, and TypeScript
 * resolves `MaterialDynamicColors.primary` to the deprecated property (which is
 * not callable). Instantiating once gives us the supported accessor methods.
 */
const mdc = new MaterialDynamicColors()

const ROLES = {
  primary: mdc.primary,
  'on-primary': mdc.onPrimary,
  'primary-container': mdc.primaryContainer,
  'on-primary-container': mdc.onPrimaryContainer,
  secondary: mdc.secondary,
  'on-secondary': mdc.onSecondary,
  'secondary-container': mdc.secondaryContainer,
  'on-secondary-container': mdc.onSecondaryContainer,
  tertiary: mdc.tertiary,
  'on-tertiary': mdc.onTertiary,
  'tertiary-container': mdc.tertiaryContainer,
  'on-tertiary-container': mdc.onTertiaryContainer,
  error: mdc.error,
  'on-error': mdc.onError,
  'error-container': mdc.errorContainer,
  'on-error-container': mdc.onErrorContainer,
  background: mdc.background,
  'on-background': mdc.onBackground,
  surface: mdc.surface,
  'on-surface': mdc.onSurface,
  'surface-variant': mdc.surfaceVariant,
  'on-surface-variant': mdc.onSurfaceVariant,
  'surface-dim': mdc.surfaceDim,
  'surface-bright': mdc.surfaceBright,
  'surface-container-lowest': mdc.surfaceContainerLowest,
  'surface-container-low': mdc.surfaceContainerLow,
  'surface-container': mdc.surfaceContainer,
  'surface-container-high': mdc.surfaceContainerHigh,
  'surface-container-highest': mdc.surfaceContainerHighest,
  outline: mdc.outline,
  'outline-variant': mdc.outlineVariant,
  shadow: mdc.shadow,
  scrim: mdc.scrim,
  'inverse-surface': mdc.inverseSurface,
  'inverse-on-surface': mdc.inverseOnSurface,
  'inverse-primary': mdc.inversePrimary,
  'surface-tint': mdc.surfaceTint,
} as const

type RoleName = keyof typeof ROLES

/** Break an ARGB int into the bare `R G B` channel string Tailwind expects. */
function channels(argb: number): string {
  return `${(argb >> 16) & 0xff} ${(argb >> 8) & 0xff} ${argb & 0xff}`
}

/** Normalise `#abc` / `abc` / `#aabbcc` into `#aabbcc`, or throw. */
function normalizeHex(seed: string): string {
  const raw = seed.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(raw)) {
    throw new Error(`[theme] Invalid seed colour: ${seed}`)
  }
  const full = raw.length === 3 ? raw.replace(/./g, (c) => c + c) : raw
  return `#${full.toLowerCase()}`
}

interface ModeConfig {
  seed: string
  overrides?: Record<string, string>
}

function modeConfig(mode: ThemeMode): ModeConfig {
  const modes = tokens.color.modes as Record<ThemeMode, ModeConfig>
  const config = modes[mode] ?? modes.dark
  return { ...config, seed: config?.seed ?? tokens.color.seed }
}

/**
 * Build the tonal palette for a mode. Returns both the resolved scheme and the
 * flat role→ARGB map so callers can assert on exact values.
 */
export function buildPalette(mode: ThemeMode): {
  scheme: DynamicScheme
  argb: Record<RoleName, number>
} {
  const config = modeConfig(mode)
  const seedArgb = argbFromHex(normalizeHex(config.seed))
  const isDark = mode !== 'light'
  const contrastLevel = (tokens.color.contrastLevel as Record<ThemeMode, number>)[mode] ?? 0

  const scheme = new SchemeTonalSpot(
    Hct.fromInt(seedArgb),
    isDark,
    contrastLevel,
    tokens.color.specVersion as '2021' | '2025',
  )

  const argb = {} as Record<RoleName, number>
  for (const role of Object.keys(ROLES) as RoleName[]) {
    argb[role] = ROLES[role]().getArgb(scheme)
  }

  // AMOLED flattens the surface ramp to true black. Applied after generation so
  // the accent roles still come from the tonal palette.
  for (const [role, hex] of Object.entries(config.overrides ?? {})) {
    if (role in argb) argb[role as RoleName] = argbFromHex(normalizeHex(hex))
  }

  return { scheme, argb }
}

/** Build the complete CSS custom-property block for a mode. */
export function buildThemeVars(mode: ThemeMode): Record<string, string> {
  const { argb } = buildPalette(mode)
  const vars: Record<string, string> = {}

  for (const [role, value] of Object.entries(argb) as [RoleName, number][]) {
    const hex = hexFromArgb(value)
    vars[`--md-sys-color-${role}`] = hex
    vars[`--md-${role}`] = hex
    vars[`--md-${role}-rgb`] = channels(value)
  }

  // Role-colour aliases used by the surface helpers in src/index.css.
  vars['--md-background'] = hexFromArgb(argb.background)
  vars['--md-background-rgb'] = channels(argb.background)
  vars['--md-on-background-rgb'] = channels(argb['on-background'])

  const dark = mode !== 'light'
  vars['color-scheme'] = dark ? 'dark' : 'light'

  // Tactical overlays, derived from generated roles so they rebrand with the seed.
  vars['--md-glass'] =
    dark ? 'color-mix(in srgb, var(--md-surface) 72%, transparent)' : 'color-mix(in srgb, var(--md-on-surface) 72%, transparent)'
  vars['--md-glow'] = `0 0 15px color-mix(in srgb, ${hexFromArgb(argb.primary)} 30%, transparent)`

  return vars
}

function applyMode(mode: ThemeMode): void {
  const root = document.documentElement
  for (const [prop, value] of Object.entries(buildThemeVars(mode))) {
    root.style.setProperty(prop, value)
  }
  root.setAttribute('data-theme', mode)
  root.setAttribute('data-md-theme', mode)
}

/** System colour-scheme query, live. */
export function prefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true
}

/**
 * Resolve the boot mode: a persisted user choice always wins; otherwise defer to
 * the OS preference. This keeps the existing `profiles.theme_mode` behaviour
 * intact while letting a first-time visitor inherit their system setting.
 */
export function resolveInitialMode(): ThemeMode {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(THEME_STORAGE_KEY)
  } catch {
    stored = null
  }
  if (stored === 'light' || stored === 'dark' || stored === 'amoled') return stored
  return prefersDark() ? 'dark' : 'light'
}

type ModeListener = (mode: ThemeMode) => void

/**
 * Subscribe to OS appearance changes.
 *
 * Only fires while the user has *not* made an explicit choice — once they pick a
 * mode we stop tracking the system so it cannot override their stored
 * preference (matching the "user choice wins" rule).
 */
export function watchSystemMode(listener: ModeListener): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {}
  }
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => {
    if (hasExplicitChoice()) return
    listener(query.matches ? 'dark' : 'light')
  }
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }
  query.addListener(onChange)
  return () => query.removeListener(onChange)
}

export function hasExplicitChoice(): boolean {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return stored === 'light' || stored === 'dark' || stored === 'amoled'
  } catch {
    return false
  }
}

/** Persist and apply an explicit user choice. */
export function setMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    /* storage disabled — the in-memory DOM attribute still applies */
  }
  applyMode(mode)
}

/** Initialise the theme. Safe to call once, as early as possible. */
export function initTheme(): ThemeMode {
  const mode = resolveInitialMode()
  applyMode(mode)
  return mode
}

export { tokens as themeTokens }