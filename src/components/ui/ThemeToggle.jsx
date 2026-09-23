import { Moon, Zap } from 'lucide-react'
import { useTheme } from '@/contexts/ThemeContext'

export function ThemeToggle({ className = '' }) {
  const { theme, setTheme } = useTheme()
  const isAmoled = theme === 'amoled'

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <div className="flex items-center gap-1 rounded-full border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] p-1">
        <button
          type="button"
          onClick={() => setTheme('dark')}
          aria-pressed={!isAmoled}
          className={`touch-target inline-flex items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors ${!isAmoled ? 'bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)]' : 'text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]'}`}
        >
          <Moon size={16} /> Dark
        </button>
        <button
          type="button"
          onClick={() => setTheme('amoled')}
          aria-pressed={isAmoled}
          className={`touch-target inline-flex items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors ${isAmoled ? 'bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)]' : 'text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]'}`}
        >
          <Zap size={16} /> AMOLED
        </button>
      </div>
      {isAmoled && <span className="text-xs text-[var(--md-on-surface-variant)]">Battery saver</span>}
    </div>
  )
}

export default ThemeToggle

export function ThemeCard() {
  const { theme, setTheme } = useTheme()
  const themes = [
    { key: 'dark', label: 'Dark', desc: 'Material dark surfaces', bg: '#111318', surface: '#1d1f24', accent: '#a8c7fa' },
    { key: 'amoled', label: 'AMOLED', desc: 'True black — OLED optimized', bg: '#000000', surface: '#111111', accent: '#a8c7fa', badge: '🔋' },
  ]

  return (
    <div>
      <div className="mb-3 text-sm font-semibold text-[var(--md-on-surface)]">Display theme</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {themes.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTheme(t.key)}
            aria-pressed={theme === t.key}
            className={`relative overflow-hidden rounded-2xl border transition-colors text-left ${theme === t.key ? 'border-[var(--md-primary)]' : 'border-[var(--md-outline-variant)] hover:border-[var(--md-outline)]'}`}
          >
            <div className="relative h-16" style={{ backgroundColor: t.bg }}>
              <div className="absolute left-2 right-2 top-2 h-2.5 rounded-full" style={{ backgroundColor: t.surface }} />
              <div className="absolute left-2 top-6 h-2 w-12 rounded-full" style={{ backgroundColor: t.surface }} />
              <div className="absolute right-2 top-6 h-2 w-6 rounded-full" style={{ backgroundColor: t.accent, opacity: 0.7 }} />
              {theme === t.key && <div className="absolute right-2 top-2 grid h-5 w-5 place-items-center rounded-full bg-[var(--md-primary)] text-[var(--md-on-primary)] text-xs font-bold">✓</div>}
            </div>
            <div className="px-4 py-3" style={{ backgroundColor: t.surface }}>
              <div className="flex items-center gap-2">
                {t.badge && <span className="text-xs">{t.badge}</span>}
                <span className="text-sm font-semibold text-[var(--md-on-surface)]">{t.label}</span>
              </div>
              <div className="mt-0.5 text-xs text-[var(--md-on-surface-variant)]">{t.desc}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
