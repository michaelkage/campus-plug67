/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'campus-dark': '#0a0a0a', 'campus-gray': '#1a1a1a', 'campus-green': '#00ff88',
        'campus-red': '#ff4444', 'campus-yellow': '#ffaa00', 'campus-blue': '#00aaff',
        'plug-green': { DEFAULT: '#a8c7fa', 50: '#eaf2ff', 100: '#d7e7ff', 500: '#a8c7fa', 600: '#8fb8f2', 700: '#719edc', 900: '#234a7d' },
        'plug-red': { DEFAULT: '#ffb4ab', 500: '#ffb4ab', 600: '#ff897d' },
        'plug-amber': { DEFAULT: '#e6c35a', 500: '#e6c35a', 600: '#c7a642' },
        obsidian: {
          DEFAULT: '#111318', 100: '#1d1f24', 300: '#282a2f', 400: '#1d1f24',
          500: '#33353a', 800: '#1d1f24', 900: '#111318', 950: '#0b0d10',
        },
        cyan: { DEFAULT: '#a8c7fa', 400: '#d7e7ff', 500: '#a8c7fa', 600: '#8fb8f2' },
        purple: { DEFAULT: '#bec6d7', 400: '#dbe2f2', 500: '#bec6d7', 600: '#a5adbe' },
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
