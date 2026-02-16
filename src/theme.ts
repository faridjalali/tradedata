export type ThemeName = 'dark' | 'light' | 'beige';

export interface ThemeColors {
  bgColor: string;
  cardBg: string;
  surfaceElevated: string;
  surfaceOverlay: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  borderColor: string;
  highlight: string;
  bgOverlay95: string;
  cardBgOverlay95: string;
  cardBgOverlay60: string;
  cardBgOverlay50: string;
  borderOverlay22: string;
  borderOverlay30: string;
  highlightOverlay10: string;
  dividerColor: string;
  shadowColor: string;
  monthGridlineColor: string;
  spinnerColor: string;
}

const THEMES: Record<ThemeName, ThemeColors> = {
  dark: {
    bgColor: '#0d1117',
    cardBg: '#161b22',
    surfaceElevated: '#21262d',
    surfaceOverlay: 'rgba(22, 27, 34, 0.98)',
    textPrimary: '#c9d1d9',
    textSecondary: '#8b949e',
    textMuted: '#484f58',
    borderColor: '#30363d',
    highlight: '#58a6ff',
    bgOverlay95: 'rgba(13, 17, 23, 0.95)',
    cardBgOverlay95: 'rgba(22, 27, 34, 0.95)',
    cardBgOverlay60: 'rgba(22, 27, 34, 0.6)',
    cardBgOverlay50: 'rgba(22, 27, 34, 0.5)',
    borderOverlay22: 'rgba(48, 54, 61, 0.22)',
    borderOverlay30: 'rgba(48, 54, 61, 0.3)',
    highlightOverlay10: 'rgba(88, 166, 255, 0.1)',
    dividerColor: 'rgba(255, 255, 255, 0.1)',
    shadowColor: 'rgba(0, 0, 0, 0.4)',
    monthGridlineColor: '#21262d',
    spinnerColor: '#58a6ff',
  },
  light: {
    bgColor: '#ffffff',
    cardBg: '#f6f8fa',
    surfaceElevated: '#e1e4e8',
    surfaceOverlay: 'rgba(246, 248, 250, 0.98)',
    textPrimary: '#24292e',
    textSecondary: '#586069',
    textMuted: '#959da5',
    borderColor: '#d0d7de',
    highlight: '#0969da',
    bgOverlay95: 'rgba(255, 255, 255, 0.95)',
    cardBgOverlay95: 'rgba(246, 248, 250, 0.95)',
    cardBgOverlay60: 'rgba(246, 248, 250, 0.6)',
    cardBgOverlay50: 'rgba(246, 248, 250, 0.5)',
    borderOverlay22: 'rgba(208, 215, 222, 0.22)',
    borderOverlay30: 'rgba(208, 215, 222, 0.3)',
    highlightOverlay10: 'rgba(9, 105, 218, 0.1)',
    dividerColor: 'rgba(0, 0, 0, 0.1)',
    shadowColor: 'rgba(0, 0, 0, 0.12)',
    monthGridlineColor: '#e1e4e8',
    spinnerColor: '#0969da',
  },
  beige: {
    bgColor: '#F5F0E8',
    cardBg: '#FFFFFF',
    surfaceElevated: '#E8E2D8',
    surfaceOverlay: 'rgba(255, 255, 255, 0.98)',
    textPrimary: '#3D3929',
    textSecondary: '#7A7464',
    textMuted: '#A39E90',
    borderColor: '#DDD6C8',
    highlight: '#D97706',
    bgOverlay95: 'rgba(245, 240, 232, 0.95)',
    cardBgOverlay95: 'rgba(255, 255, 255, 0.95)',
    cardBgOverlay60: 'rgba(255, 255, 255, 0.6)',
    cardBgOverlay50: 'rgba(255, 255, 255, 0.5)',
    borderOverlay22: 'rgba(221, 214, 200, 0.22)',
    borderOverlay30: 'rgba(221, 214, 200, 0.3)',
    highlightOverlay10: 'rgba(217, 119, 6, 0.1)',
    dividerColor: 'rgba(0, 0, 0, 0.08)',
    shadowColor: 'rgba(0, 0, 0, 0.1)',
    monthGridlineColor: '#E8E2D8',
    spinnerColor: '#D97706',
  },
};

const THEME_STORAGE_KEY = 'app_theme';
let currentTheme: ThemeName = 'dark';

export function getTheme(): ThemeName {
  return currentTheme;
}

export function getThemeColors(): ThemeColors {
  return THEMES[currentTheme];
}

export function setTheme(name: ThemeName): void {
  if (name === currentTheme) return;
  currentTheme = name;
  applyThemeToDOM();
  try { localStorage.setItem(THEME_STORAGE_KEY, name); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: name } }));
}

function applyThemeToDOM(): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', currentTheme);
  const t = THEMES[currentTheme];
  root.style.setProperty('--bg-color', t.bgColor);
  root.style.setProperty('--card-bg', t.cardBg);
  root.style.setProperty('--surface-elevated', t.surfaceElevated);
  root.style.setProperty('--surface-overlay', t.surfaceOverlay);
  root.style.setProperty('--text-primary', t.textPrimary);
  root.style.setProperty('--text-secondary', t.textSecondary);
  root.style.setProperty('--text-muted', t.textMuted);
  root.style.setProperty('--border-color', t.borderColor);
  root.style.setProperty('--highlight', t.highlight);
  root.style.setProperty('--bg-overlay-95', t.bgOverlay95);
  root.style.setProperty('--card-bg-overlay-95', t.cardBgOverlay95);
  root.style.setProperty('--card-bg-overlay-60', t.cardBgOverlay60);
  root.style.setProperty('--card-bg-overlay-50', t.cardBgOverlay50);
  root.style.setProperty('--border-overlay-22', t.borderOverlay22);
  root.style.setProperty('--border-overlay-30', t.borderOverlay30);
  root.style.setProperty('--highlight-overlay-10', t.highlightOverlay10);
  root.style.setProperty('--divider-color', t.dividerColor);
  root.style.setProperty('--shadow-color', t.shadowColor);
  root.style.setProperty('--month-gridline-color', t.monthGridlineColor);
  root.style.setProperty('--spinner-color', t.spinnerColor);
}

export function initTheme(): void {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'beige' || stored === 'dark') {
      currentTheme = stored;
    }
  } catch { /* ignore */ }
  applyThemeToDOM();
}
