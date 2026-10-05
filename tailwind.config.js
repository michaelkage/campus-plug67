// Material You token -> CSS custom property in src/index.css.
//
// The app authors components with unprefixed Material role names
// (bg-surface-container, border-outline-variant, text-primary, ...).
// Without these entries Tailwind never generates them and the class is
// silently dropped, leaving the element unstyled. Mapping the roles here
// makes all of them resolve against the single theme source of truth.
//
// These point at the `-rgb` channel twins rather than the hex tokens because
// Tailwind substitutes <alpha-value> as a number (0.4), which `rgb(... / 0.4)`
// accepts. A hex custom property cannot carry an injected alpha, and routing
// this through color-mix() would need a percentage Tailwind does not provide.
const token = (role) => `rgb(var(--md-${role}-rgb) / <alpha-value>)`

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: token('primary'),
        'on-primary': token('on-primary'),
        'primary-container': token('primary-container'),
        'on-primary-container': token('on-primary-container'),
        secondary: token('secondary'),
        'on-secondary': token('on-secondary'),
        'secondary-container': token('secondary-container'),
        'on-secondary-container': token('on-secondary-container'),
        tertiary: token('tertiary'),
        'on-tertiary': token('on-tertiary'),
        'tertiary-container': token('tertiary-container'),
        'on-tertiary-container': token('on-tertiary-container'),
        error: token('error'),
        'on-error': token('on-error'),
        surface: token('surface'),
        'on-surface': token('on-surface'),
        'surface-container': token('surface-container'),
        'surface-container-high': token('surface-container-high'),
        'surface-container-highest': token('surface-container-highest'),
        'on-surface-variant': token('on-surface-variant'),
        outline: token('outline'),
        'outline-variant': token('outline-variant'),
        scrim: token('scrim'),
        'inverse-surface': token('inverse-surface'),
        'inverse-on-surface': token('inverse-on-surface'),
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'monospace'], sans: ['"Inter"', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite', glitch: 'glitch 1s linear infinite',
      },
      keyframes: {
        glitch: {
          '2%, 64%': { transform: 'translate(2px,0) skew(0deg)' },
          '4%, 60%': { transform: 'translate(-2px,0) skew(0deg)' },
          '62%': { transform: 'translate(0,0) skew(5deg)' },
        },
      },
    },
  },
  plugins: [],
}
