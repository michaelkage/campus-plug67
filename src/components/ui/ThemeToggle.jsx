import { Sun, Moon, Zap } from 'lucide-react'
import { useTheme } from '@/contexts/ThemeContext'

export function ThemeToggle({ className = '' }) {
  const { theme, setTheme } = useTheme()
  const isAmoled = theme === 'amoled'

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <div className="flex items-center gap-1 rounded-sm border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] p-1">
        <button
          type="button"
          onClick={() => setTheme('light')}
          aria-pressed={theme === 'light'}
          className={`touch-target inline-flex items-center gap-2 rounded-sm px-4 text-sm font-medium transition-colors ${theme === 'light' ? 'bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)]' : 'text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]'}`}
        >
          <Sun size={16} /> Light
        </button>
        <button
          type="button"
          onClick={() => setTheme('dark')}
          aria-pressed={theme === 'dark'}
          className={`touch-target inline-flex items-center gap-2 rounded-sm px-4 text-sm font-medium transition-colors ${theme === 'dark' ? 'bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)]' : 'text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]'}`}
        >
          <Moon size={16} /> Dark
        </button>
        <button
          type="button"
          onClick={() => setTheme('amoled')}
          aria-pressed={isAmoled}
          className={`touch-target inline-flex items-center gap-2 rounded-sm px-4 text-sm font-medium transition-colors ${isAmoled ? 'bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)]' : 'text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]'}`}
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
    {
      key: 'light',
      label: 'Light',
      desc: 'Premium sand and terracotta',
      bg: '#FAF6F0',
      surface: '#EFEBE5',
      accent: '#D95D39',
    },
    {
      key: 'dark',
      label: 'Dark',
      desc: 'Volcanic charcoal and mineral ore',
      bg: 'var(--md-surface)',
      surface: 'var(--md-surface-container)',
      accent: 'var(--md-secondary)',
    },
    {
      key: 'amoled',
      label: 'AMOLED',
      desc: 'Volcanic charcoal with reduced effects',
      bg: 'var(--md-surface)',
      surface: 'var(--md-surface)',
      accent: 'var(--md-secondary)',
      badge: '🔋',
    },
  ]

  return (
    <div>
      <div className="mb-3 text-sm font-semibold text-[var(--md-on-surface)]">Display theme</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {themes.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTheme(t.key)}
            aria-pressed={theme === t.key}
            className={`relative overflow-hidden rounded-md border transition-colors text-left ${theme === t.key ? 'border-[var(--md-primary)]' : 'border-[var(--md-outline-variant)] hover:border-[var(--md-outline)]'}`}
          >
            <div className="relative h-16" style={{ backgroundColor: t.bg }}>
              <div className="absolute left-2 right-2 top-2 h-2.5 rounded-sm" style={{ backgroundColor: t.surface }} />
              <div className="absolute left-2 top-6 h-2 w-12 rounded-sm" style={{ backgroundColor: t.surface }} />
              <div className="absolute right-2 top-6 h-2 w-6 rounded-sm" style={{ backgroundColor: t.accent, opacity: 0.7 }} />
              {theme === t.key && <div className="absolute right-2 top-2 grid h-5 w-5 place-items-center rounded-sm bg-[var(--md-primary)] text-[var(--md-on-primary)] text-xs font-bold">✓</div>}
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
