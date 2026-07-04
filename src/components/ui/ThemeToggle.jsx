import { motion } from 'framer-motion'
import { Moon, Zap } from 'lucide-react'
import { useTheme } from '@/contexts/ThemeContext'

export function ThemeToggle({ className = '' }) {
  const { theme, setTheme } = useTheme()
  const isAmoled = theme === 'amoled'
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <div className="flex bg-obsidian-300 rounded-xl p-1 border border-obsidian-500">
        <button onClick={() => setTheme('dark')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
            !isAmoled ? 'bg-obsidian-400 text-white border border-obsidian-500' : 'text-white/40 hover:text-white/60'
          }`}>
          <Moon size={12} /> Dark
        </button>
        <button onClick={() => setTheme('amoled')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
            isAmoled ? 'bg-black text-cyan border border-cyan/30' : 'text-white/40 hover:text-white/60'
          }`}>
          <Zap size={12} /> AMOLED
        </button>
      </div>
      {isAmoled && <span className="text-[10px] text-cyan/60">🔋 Battery saver</span>}
    </div>
  )
}

export function ThemeCard() {
  const { theme, setTheme } = useTheme()
  const themes = [
    { key: 'dark',   label: 'Dark',   desc: 'Obsidian — default',         bg: '#080B0F', surface: '#0D1117', accent: '#00F2FF' },
    { key: 'amoled', label: 'AMOLED', desc: 'True black — OLED optimized', bg: '#000000', surface: '#0a0a0a', accent: '#00F2FF', badge: '🔋' },
  ]
  return (
    <div>
      <div className="text-xs font-bold text-white/40 uppercase tracking-wider mb-3">Display Theme</div>
      <div className="grid grid-cols-2 gap-3">
        {themes.map(t => (
          <button key={t.key} onClick={() => setTheme(t.key)}
            className={`relative rounded-xl border-2 overflow-hidden text-left transition-all ${
              theme === t.key ? 'border-cyan' : 'border-obsidian-500 hover:border-obsidian-400'
            }`}>
            <div className="h-16 relative" style={{ backgroundColor: t.bg }}>
              <div className="absolute top-2 left-2 right-2 h-2.5 rounded-sm" style={{ backgroundColor: t.surface }} />
              <div className="absolute top-6 left-2 w-12 h-2 rounded-sm" style={{ backgroundColor: t.surface }} />
              <div className="absolute top-6 right-2 w-6 h-2 rounded-sm" style={{ backgroundColor: t.accent, opacity: 0.7 }} />
              {theme === t.key && (
                <div className="absolute top-1.5 right-1.5 w-3.5 h-3.5 rounded-full bg-cyan flex items-center justify-center">
                  <span className="text-obsidian text-[8px] font-black">✓</span>
                </div>
              )}
            </div>
            <div className="px-3 py-2" style={{ backgroundColor: t.surface }}>
              <div className="flex items-center gap-1">
                {t.badge && <span className="text-xs">{t.badge}</span>}
                <span className={`text-xs font-bold ${theme === t.key ? 'text-cyan' : 'text-white/80'}`}>{t.label}</span>
              </div>
              <div className="text-[10px] text-white/40">{t.desc}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
