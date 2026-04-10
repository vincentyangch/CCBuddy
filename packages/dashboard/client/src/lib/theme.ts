export type ThemePreference = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'dashboard_theme';

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'system' || value === 'dark' || value === 'light';
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') {
    return systemPrefersDark ? 'dark' : 'light';
  }
  return preference;
}

export function nextTheme(preference: ThemePreference): ThemePreference {
  if (preference === 'dark') return 'light';
  if (preference === 'light') return 'system';
  return 'dark';
}

export function themeLabel(preference: ThemePreference): string {
  if (preference === 'dark') return 'Dark';
  if (preference === 'light') return 'Light';
  return 'System';
}
