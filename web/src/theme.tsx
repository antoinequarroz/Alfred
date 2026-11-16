import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'auto';
const LABELS: Record<Theme, string> = { light: 'Clair', dark: 'Sombre', auto: 'Auto' };

function stored(): Theme {
  try {
    const t = localStorage.getItem('alfred:theme');
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch {
    return 'auto';
  }
}

function systemDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(stored);
  const [sysDark, setSysDark] = useState(systemDark);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSysDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === 'auto') localStorage.removeItem('alfred:theme');
      else localStorage.setItem('alfred:theme', theme);
    } catch {
      // stockage indisponible : le choix vaut pour cette session
    }
    const dark = theme === 'dark' || (theme === 'auto' && sysDark);
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#0c0c0e' : '#ffffff'));
  }, [theme, sysDark]);

  const dark = theme === 'dark' || (theme === 'auto' && sysDark);
  return { theme, setTheme, dark, toggle: () => setTheme(dark ? 'light' : 'dark') };
}

export function ThemeSwitch({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  return (
    <div className="seg small" role="radiogroup" aria-label="Thème">
      {(Object.keys(LABELS) as Theme[]).map((t) => (
        <button key={t} role="radio" aria-checked={theme === t} className={theme === t ? 'active' : ''} onClick={() => onChange(t)}>
          {LABELS[t]}
        </button>
      ))}
    </div>
  );
}

export function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

export function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
    </svg>
  );
}
