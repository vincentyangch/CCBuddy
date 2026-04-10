import { describe, expect, it } from 'vitest';
import { nextTheme, resolveTheme, type ThemePreference } from './theme';

describe('dashboard theme helpers', () => {
  it('uses system preference when preference is system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('uses explicit dark and light preferences', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('cycles through dark, light, and system', () => {
    const order: ThemePreference[] = ['dark', 'light', 'system'];
    expect(order.map(nextTheme)).toEqual(['light', 'system', 'dark']);
  });
});
