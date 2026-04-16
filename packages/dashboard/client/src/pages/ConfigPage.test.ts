// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigPage } from './ConfigPage';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getLocalSettings: vi.fn(),
    getEffectiveSettings: vi.fn(),
    getSettingsMeta: vi.fn(),
    getBackend: vi.fn(),
    getModel: vi.fn(),
    updateLocalSettings: vi.fn(),
  },
}));

vi.mock('../lib/api', () => ({
  api: apiMock,
}));

vi.mock('../components/ModelSelector', async () => {
  const { createElement: createReactElement } = await import('react');
  return {
    ModelSelector: () => createReactElement('div', null, 'model-selector'),
  };
});

vi.mock('../components/ModelListEditor', async () => {
  const { createElement: createReactElement } = await import('react');
  return {
    ModelListEditor: () => createReactElement('div', null, 'model-list-editor'),
  };
});

vi.mock('../components/BackendSelector', async () => {
  const { createElement: createReactElement } = await import('react');
  return {
    BackendSelector: () => createReactElement('div', null, 'backend-selector'),
  };
});

describe('ConfigPage', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let lastSavedConfig: Record<string, unknown> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);

    apiMock.getLocalSettings.mockResolvedValue({
      config: {
        scheduler: {
          timezone: 'America/Chicago',
          jobs: {
            morning_briefing_weekday: {
              cron: '0 7 * * 1-5',
              prompt: 'brief',
              user: 'flyingchickens',
            },
          },
        },
        agent: {
          backend: 'codex-sdk',
        },
      },
    });
    apiMock.getEffectiveSettings.mockResolvedValue({
      config: {
        agent: {
          backend: 'codex-sdk',
        },
        scheduler: {
          timezone: 'America/Chicago',
          default_target: {
            platform: 'discord',
            channel: 'abc123',
          },
          jobs: {
            morning_briefing_weekday: {
              cron: '0 7 * * 1-5',
              prompt: 'brief',
              user: 'flyingchickens',
            },
          },
        },
      },
    });
    apiMock.getSettingsMeta.mockResolvedValue({ sources: {} });
    apiMock.getBackend.mockResolvedValue({
      backend: 'codex-sdk',
      models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-pro'],
      claude_models: [],
      codex_models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-pro'],
    });
    apiMock.getModel.mockResolvedValue({
      model: 'gpt-5.4',
      source: 'runtime_override',
      backend: 'codex-sdk',
      reasoning_effort: 'medium',
      reasoning_effort_source: 'runtime_override',
      verbosity: 'medium',
      verbosity_source: 'runtime_override',
      reasoning_effort_options: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      verbosity_options: ['low', 'medium', 'high'],
    });
    apiMock.updateLocalSettings.mockImplementation(async (config: Record<string, unknown>) => {
      lastSavedConfig = config;
      return { ok: true };
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    document.body.innerHTML = '';
    lastSavedConfig = null;
  });

  async function renderPage() {
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(ConfigPage));
    });
  }

  async function flushUpdates() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('renders scheduler job model, reasoning, and verbosity controls and persists them to local settings', async () => {
    await renderPage();
    await flushUpdates();

    const schedulerTab = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Scheduler');
    expect(schedulerTab).toBeDefined();

    await act(async () => {
      schedulerTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushUpdates();

    const modelSelect = container.querySelector('#scheduler-job-morning_briefing_weekday-model-select') as HTMLSelectElement | null;
    const reasoningSelect = container.querySelector('#scheduler-job-morning_briefing_weekday-reasoning-select') as HTMLSelectElement | null;
    const verbositySelect = container.querySelector('#scheduler-job-morning_briefing_weekday-verbosity-select') as HTMLSelectElement | null;

    expect(modelSelect).not.toBeNull();
    expect(reasoningSelect).not.toBeNull();
    expect(verbositySelect).not.toBeNull();

    await act(async () => {
      modelSelect!.value = 'gpt-5.4-pro';
      modelSelect!.dispatchEvent(new Event('change', { bubbles: true }));
      reasoningSelect!.value = 'high';
      reasoningSelect!.dispatchEvent(new Event('change', { bubbles: true }));
      verbositySelect!.value = 'low';
      verbositySelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushUpdates();

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Save Local Settings'));
    expect(saveButton?.hasAttribute('disabled')).toBe(false);

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushUpdates();

    expect(apiMock.updateLocalSettings).toHaveBeenCalledOnce();
    expect(lastSavedConfig).toMatchObject({
      scheduler: {
        jobs: {
          morning_briefing_weekday: {
            model: 'gpt-5.4-pro',
            reasoning_effort: 'high',
            verbosity: 'low',
          },
        },
      },
    });
  });
});
