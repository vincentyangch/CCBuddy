import { describe, expect, it } from 'vitest';
import { validateLocalSettingsConfig } from '../settings-meta.js';

describe('settings-meta', () => {
  it('accepts scheduler codex defaults and per-job overrides', () => {
    const config = {
      scheduler: {
        default_model: 'gpt-5.4-mini',
        default_reasoning_effort: 'high',
        default_verbosity: 'low',
        jobs: {
          morning_briefing: {
            model: 'gpt-5.4',
            reasoning_effort: 'xhigh',
            verbosity: 'medium',
          },
        },
      },
    };

    expect(validateLocalSettingsConfig(config)).toBeNull();
  });
});
