// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSelector } from './ModelSelector';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getModel: vi.fn(),
    getBackend: vi.fn(),
    setModel: vi.fn(),
  },
}));

vi.mock('../lib/api', () => ({
  api: apiMock,
}));

describe('ModelSelector', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);

    apiMock.getBackend.mockResolvedValue({
      backend: 'codex-sdk',
      models: ['gpt-5.4', 'gpt-5.4-mini'],
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
  });

  it('renders safely when getModel omits service tier fields', async () => {
    apiMock.getModel.mockResolvedValue({
      model: 'gpt-5.4',
      source: 'runtime_override',
      backend: 'codex-sdk',
      reasoning_effort: 'high',
      reasoning_effort_source: 'runtime_override',
      verbosity: 'medium',
      verbosity_source: 'runtime_override',
      reasoning_effort_options: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      verbosity_options: ['low', 'medium', 'high'],
    } as any);

    await act(async () => {
      root = createRoot(container);
      root.render(createElement(ModelSelector));
    });

    expect(container.querySelector('#runtime-model-select')).not.toBeNull();
    expect(container.querySelector('#runtime-reasoning-effort-select')).not.toBeNull();
    expect(container.querySelector('#runtime-service-tier-select')).not.toBeNull();
  });
});
