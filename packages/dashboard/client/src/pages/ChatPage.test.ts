// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPage } from './ChatPage';

const { apiMock, useWebSocketMock } = vi.hoisted(() => ({
  apiMock: {
    conversations: vi.fn(),
    sessions: vi.fn(),
    getBackend: vi.fn(),
    getModel: vi.fn(),
    setSessionSettings: vi.fn(),
    deleteConversation: vi.fn(),
  },
  useWebSocketMock: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  api: apiMock,
}));

vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: (options: unknown) => useWebSocketMock(options),
}));

vi.mock('../components/ChatSidebar', async () => {
  const { createElement: createReactElement } = await import('react');
  return {
    ChatSidebar: (props: { onSelectSession: (session: { sessionId: string; channelId: string }) => void }) =>
      createReactElement(
        'button',
        {
          type: 'button',
          onClick: () => props.onSelectSession({
            sessionId: 'po-webchat-webchat-main',
            channelId: 'webchat-main',
          }),
        },
        'Select existing chat',
      ),
  };
});

vi.mock('../components/ChatInput', async () => {
  const { createElement: createReactElement } = await import('react');
  return {
    ChatInput: () => createReactElement('div', null, 'chat-input'),
  };
});

describe('ChatPage', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let currentSession: {
    session_key: string;
    sessionKey: string;
    platform: string;
    channel_id: string;
    channelId: string;
    model: string | null;
    reasoning_effort: string | null;
    service_tier: string | null;
    verbosity: string | null;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });

    currentSession = {
      session_key: 'po-webchat-webchat-main',
      sessionKey: 'po-webchat-webchat-main',
      platform: 'webchat',
      channel_id: 'webchat-main',
      channelId: 'webchat-main',
      model: 'gpt-5.4-mini',
      reasoning_effort: 'high',
      service_tier: 'fast',
      verbosity: 'low',
    };

    useWebSocketMock.mockReturnValue({
      connected: true,
      send: vi.fn(),
    });

    apiMock.conversations.mockResolvedValue({
      messages: [
        {
          id: 'msg-1',
          sessionId: 'po-webchat-webchat-main',
          role: 'assistant',
          content: 'Existing answer',
          timestamp: 1,
        },
      ],
    });
    apiMock.sessions.mockImplementation(async () => ({
      sessions: [{ ...currentSession }],
    }));
    apiMock.getBackend.mockResolvedValue({
      backend: 'codex-sdk',
      models: ['gpt-5.4', 'gpt-5.4-mini'],
      claude_models: [],
      codex_models: ['gpt-5.4', 'gpt-5.4-mini'],
    });
    apiMock.getModel.mockResolvedValue({
      model: 'gpt-5.4',
      source: 'runtime_override',
      backend: 'codex-sdk',
      reasoning_effort: 'medium',
      reasoning_effort_source: 'runtime_override',
      service_tier: 'fast',
      service_tier_source: 'runtime_override',
      verbosity: 'medium',
      verbosity_source: 'runtime_override',
      reasoning_effort_options: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      service_tier_options: ['flex', 'fast'],
      verbosity_options: ['low', 'medium', 'high'],
    });
    apiMock.setSessionSettings.mockImplementation(async (_key: string, payload: {
      model?: string | null;
      reasoning_effort?: string | null;
      service_tier?: string | null;
      verbosity?: string | null;
    }) => {
      currentSession = { ...currentSession, ...payload };
      return {
        ok: true,
        session_key: currentSession.session_key,
        model: currentSession.model,
        reasoning_effort: currentSession.reasoning_effort,
        service_tier: currentSession.service_tier,
        verbosity: currentSession.verbosity,
      };
    });
    apiMock.deleteConversation.mockResolvedValue({ success: true });
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

  async function renderPage() {
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(ChatPage));
    });
  }

  async function flushUpdates() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('renders live per-session runtime controls for selected webchat sessions and saves updates', async () => {
    await renderPage();

    const selectSessionButton = container.querySelector('button');
    expect(selectSessionButton?.textContent).toContain('Select existing chat');

    await act(async () => {
      selectSessionButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushUpdates();

    const modelSelect = container.querySelector('#chat-session-model-select') as HTMLSelectElement | null;
    const reasoningSelect = container.querySelector('#chat-session-reasoning-select') as HTMLSelectElement | null;
    const serviceTierSelect = container.querySelector('#chat-session-service-tier-select') as HTMLSelectElement | null;
    const verbositySelect = container.querySelector('#chat-session-verbosity-select') as HTMLSelectElement | null;

    expect(modelSelect).not.toBeNull();
    expect(reasoningSelect).not.toBeNull();
    expect(serviceTierSelect).not.toBeNull();
    expect(verbositySelect).not.toBeNull();
    expect(modelSelect?.value).toBe('gpt-5.4-mini');
    expect(reasoningSelect?.value).toBe('high');
    expect(serviceTierSelect?.value).toBe('fast');
    expect(verbositySelect?.value).toBe('low');

    await act(async () => {
      modelSelect!.value = 'gpt-5.4';
      modelSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(apiMock.setSessionSettings).toHaveBeenCalledWith('po-webchat-webchat-main', { model: 'gpt-5.4' });

    await flushUpdates();
    const refreshedReasoningSelect = container.querySelector('#chat-session-reasoning-select') as HTMLSelectElement;
    await act(async () => {
      refreshedReasoningSelect.value = 'xhigh';
      refreshedReasoningSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(apiMock.setSessionSettings).toHaveBeenCalledWith('po-webchat-webchat-main', { reasoning_effort: 'xhigh' });

    await flushUpdates();
    const refreshedServiceTierSelect = container.querySelector('#chat-session-service-tier-select') as HTMLSelectElement;
    await act(async () => {
      refreshedServiceTierSelect.value = 'flex';
      refreshedServiceTierSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(apiMock.setSessionSettings).toHaveBeenCalledWith('po-webchat-webchat-main', { service_tier: 'flex' });

    await flushUpdates();
    const refreshedVerbositySelect = container.querySelector('#chat-session-verbosity-select') as HTMLSelectElement;
    await act(async () => {
      refreshedVerbositySelect.value = 'high';
      refreshedVerbositySelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(apiMock.setSessionSettings).toHaveBeenCalledWith('po-webchat-webchat-main', { verbosity: 'high' });
  });

  it('still renders when getModel omits service tier fields', async () => {
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
    } as any);

    await renderPage();

    const selectSessionButton = container.querySelector('button');
    await act(async () => {
      selectSessionButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushUpdates();

    expect(container.querySelector('#chat-session-model-select')).not.toBeNull();
    expect(container.querySelector('#chat-session-reasoning-select')).not.toBeNull();
    expect(container.querySelector('#chat-session-service-tier-select')).not.toBeNull();
  });
});
