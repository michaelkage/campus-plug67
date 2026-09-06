/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        'campus-dark': '#0a0a0a',
        'campus-gray': '#1a1a1a',
        'campus-green': '#00ff88',
        'campus-red': '#ff4444',
        'campus-yellow': '#ffaa00',
        'campus-blue': '#00aaff',
        'plug-green': {
          DEFAULT: '#00FF88', 50: '#E6FFFA', 100: '#B2F5EA', 500: '#00FF88',
          600: '#00CC6A', 700: '#00994F', 900: '#00331A',
        },
        'plug-red': { DEFAULT: '#FF3B30', 500: '#FF3B30', 600: '#D70015' },
        'plug-amber': { DEFAULT: '#FF9500', 500: '#FF9500', 600: '#C77700' },
        obsidian: { DEFAULT: '#0A0D14', 800: '#121721', 900: '#0A0D14', 950: '#05070A' },
        cyan: { DEFAULT: '#00E5FF', 400: '#33ECFF', 500: '#00E5FF', 600: '#00B8CC' },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'monospace'],
        sans: ['"Inter"', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        glitch: 'glitch 1s linear infinite',
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
