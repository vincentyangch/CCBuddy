# Interactive Follow-Ups Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Po to ask clarifying questions mid-task by handling the SDK's `AskUserQuestion` tool via `canUseTool`, presenting questions as Discord buttons, and feeding answers back.

**Architecture:** The `SdkBackend` passes a `canUseTool` callback to `query()`. When `AskUserQuestion` fires, it invokes `request.requestUserInput()` — a callback injected by the gateway. The gateway sends Discord buttons via a new `sendButtons()` adapter method, waits for interaction, and returns the answer. The SDK resumes automatically.

**Tech Stack:** TypeScript, vitest, Claude Agent SDK `canUseTool`, Discord.js `ButtonBuilder`/`ActionRowBuilder`/`awaitMessageComponent`

---

## Chunk 1: Config + Types + SdkBackend

### Task 1: Add `user_input_timeout_ms` to config

**Files:**
- Modify: `packages/core/src/config/schema.ts`
- Modify: `config/default.yaml`

- [ ] **Step 1: Add to `AgentConfig` interface**

In `packages/core/src/config/schema.ts`, add after `session_timeout_ms` in `AgentConfig`:

```typescript
  user_input_timeout_ms: number;
```

- [ ] **Step 2: Add default value in `DEFAULT_CONFIG`**

After `session_timeout_ms: 3_600_000`:

```typescript
    user_input_timeout_ms: 300_000, // 5 minutes
```

- [ ] **Step 3: Add to `config/default.yaml`**

After `session_timeout_ms: 3600000`:

```yaml
    user_input_timeout_ms: 300000
```

- [ ] **Step 4: Run config tests, commit**

Run: `npx vitest run packages/core`

```bash
git add packages/core/src/config/schema.ts config/default.yaml
git commit -m "feat(config): add user_input_timeout_ms for interactive follow-ups"
```

---

### Task 2: Add `requestUserInput` to AgentRequest and `sendButtons` to PlatformAdapter

**Files:**
- Modify: `packages/core/src/types/agent.ts`
- Modify: `packages/core/src/types/platform.ts`

- [ ] **Step 1: Add `requestUserInput` to `AgentRequest`**

In `packages/core/src/types/agent.ts`, add after `sdkSessionId`:

```typescript
  /** Callback for interactive follow-up questions (AskUserQuestion). Returns answers or null on timeout. */
  requestUserInput?: (
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect: boolean;
    }>,
    signal?: AbortSignal,
  ) => Promise<Record<string, string> | null>;
```

- [ ] **Step 2: Add `sendButtons` to `PlatformAdapter`**

In `packages/core/src/types/platform.ts`, add after `setTypingIndicator`:

```typescript
  /** Send a message with button options. Returns the selected label, or null on timeout. */
  sendButtons?(
    channelId: string,
    text: string,
    buttons: Array<{ id: string; label: string }>,
    options: { timeoutMs: number; userId?: string; signal?: AbortSignal },
  ): Promise<string | null>;
```

- [ ] **Step 3: Run type tests, commit**

Run: `npx vitest run packages/core`

```bash
git add packages/core/src/types/agent.ts packages/core/src/types/platform.ts
git commit -m "feat(core): add requestUserInput callback and sendButtons adapter method"
```

---

### Task 3: Add `canUseTool` to SdkBackend (TDD)

**Files:**
- Modify: `packages/agent/src/backends/sdk-backend.ts`
- Modify: `packages/agent/src/__tests__/sdk-backend.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `packages/agent/src/__tests__/sdk-backend.test.ts` inside the `describe('SdkBackend', ...)` block:

```typescript
  it('passes canUseTool callback when requestUserInput is provided', async () => {
    const backend = new SdkBackend();
    const requestUserInput = vi.fn().mockResolvedValue({ 'Which option?': 'Option A' });
    const events = [];
    for await (const event of backend.execute(makeRequest({ requestUserInput }))) {
      events.push(event);
    }

    const callArg = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> };
    expect(callArg.options['canUseTool']).toBeDefined();
    expect(typeof callArg.options['canUseTool']).toBe('function');
  });

  it('does not set canUseTool when requestUserInput is absent', async () => {
    const backend = new SdkBackend();
    for await (const _event of backend.execute(makeRequest())) {}

    const callArg = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> };
    expect(callArg.options['canUseTool']).toBeUndefined();
  });

  it('canUseTool calls requestUserInput for AskUserQuestion and returns allow', async () => {
    const answers = { 'Pick a color': 'Blue' };
    const requestUserInput = vi.fn().mockResolvedValue(answers);
    const backend = new SdkBackend();
    for await (const _event of backend.execute(makeRequest({ requestUserInput }))) {}

    const callArg = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> };
    const canUseTool = callArg.options['canUseTool'] as Function;

    const questions = [{ question: 'Pick a color', header: 'Colors', options: [{ label: 'Blue', description: 'A blue color' }], multiSelect: false }];
    const result = await canUseTool('AskUserQuestion', { questions }, { signal: new AbortController().signal });

    expect(requestUserInput).toHaveBeenCalledWith(questions, expect.any(AbortSignal));
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { questions, answers },
    });
  });

  it('canUseTool returns deny with message when requestUserInput returns null', async () => {
    const requestUserInput = vi.fn().mockResolvedValue(null);
    const backend = new SdkBackend();
    for await (const _event of backend.execute(makeRequest({ requestUserInput }))) {}

    const callArg = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> };
    const canUseTool = callArg.options['canUseTool'] as Function;

    const result = await canUseTool('AskUserQuestion', { questions: [] }, { signal: new AbortController().signal });
    expect(result.behavior).toBe('deny');
    expect(result.message).toBeDefined();
  });

  it('canUseTool returns allow for non-AskUserQuestion tools', async () => {
    const requestUserInput = vi.fn();
    const backend = new SdkBackend();
    for await (const _event of backend.execute(makeRequest({ requestUserInput }))) {}

    const callArg = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> };
    const canUseTool = callArg.options['canUseTool'] as Function;

    const result = await canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal });
    expect(result).toEqual({ behavior: 'allow' });
    expect(requestUserInput).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/agent/src/__tests__/sdk-backend.test.ts`

- [ ] **Step 3: Implement canUseTool in SdkBackend**

In `packages/agent/src/backends/sdk-backend.ts`, add after the session continuity block (after line 74) and before `let fullPrompt`:

```typescript
      // Interactive follow-ups — handle AskUserQuestion via requestUserInput callback
      if (request.requestUserInput) {
        options.canUseTool = async (toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal }) => {
          if (toolName === 'AskUserQuestion' && request.requestUserInput) {
            const answers = await request.requestUserInput(input.questions as any, opts.signal);
            if (!answers) {
              return { behavior: 'deny', message: 'User did not respond within the timeout period' };
            }
            return { behavior: 'allow', updatedInput: { ...input, answers } };
          }
          return { behavior: 'allow' };
        };
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/agent/src/__tests__/sdk-backend.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/backends/sdk-backend.ts packages/agent/src/__tests__/sdk-backend.test.ts
git commit -m "feat(agent): handle AskUserQuestion via canUseTool in SdkBackend"
```

---

## Chunk 2: Discord Adapter + Gateway + Bootstrap

### Task 4: Implement `sendButtons` on Discord adapter (TDD)

**Files:**
- Modify: `packages/platforms/discord/src/discord-adapter.ts`
- Modify: `packages/platforms/discord/src/__tests__/discord-adapter.test.ts`

- [ ] **Step 1: Add sendButtons method to DiscordAdapter**

In `packages/platforms/discord/src/discord-adapter.ts`, add imports at the top:

```typescript
import { Client, GatewayIntentBits, ChannelType, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
```

Add the method after `setTypingIndicator`:

```typescript
  async sendButtons(
    channelId: string,
    text: string,
    buttons: Array<{ id: string; label: string }>,
    options: { timeoutMs: number; userId?: string; signal?: AbortSignal },
  ): Promise<string | null> {
    const channel = await this.fetchTextChannel(channelId);
    if (!channel) return null;

    // Build button rows (max 5 buttons per row, max 5 rows)
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < buttons.length; i += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      const slice = buttons.slice(i, i + 5);
      for (const btn of slice) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(btn.id)
            .setLabel(btn.label.slice(0, 80))
            .setStyle(ButtonStyle.Primary),
        );
      }
      rows.push(row);
    }

    const message = await channel.send({ content: text, components: rows });

    try {
      const interaction = await message.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: options.timeoutMs,
        filter: (i) => !options.userId || i.user.id === options.userId,
      });

      // Acknowledge the interaction and disable buttons
      await interaction.update({ components: rows.map(r => {
        const disabled = ActionRowBuilder.from<ButtonBuilder>(r);
        disabled.components.forEach(c => c.setDisabled(true));
        return disabled;
      }) });

      // Find the label for the clicked button
      const clicked = buttons.find(b => b.id === interaction.customId);
      return clicked?.label ?? null;
    } catch {
      // Timeout — disable buttons
      try {
        await message.edit({ components: rows.map(r => {
          const disabled = ActionRowBuilder.from<ButtonBuilder>(r);
          disabled.components.forEach(c => c.setDisabled(true));
          return disabled;
        }) });
      } catch { /* message may have been deleted */ }
      return null;
    }
  }
```

- [ ] **Step 2: Run discord adapter tests**

Run: `npx vitest run packages/platforms/discord`

- [ ] **Step 3: Commit**

```bash
git add packages/platforms/discord/src/discord-adapter.ts
git commit -m "feat(discord): implement sendButtons with ActionRow and awaitMessageComponent"
```

---

### Task 5: Wire `requestUserInput` in Gateway (TDD)

**Files:**
- Modify: `packages/gateway/src/gateway.ts`
- Modify: `packages/gateway/src/__tests__/gateway.test.ts`

- [ ] **Step 1: Add `userInputTimeoutMs` to GatewayDeps**

In `packages/gateway/src/gateway.ts`, add to `GatewayDeps`:

```typescript
  userInputTimeoutMs?: number;
```

- [ ] **Step 2: Add `presentUserQuestions` method to Gateway**

Add this private method to the `Gateway` class:

```typescript
  private async presentUserQuestions(
    msg: IncomingMessage,
    user: { name: string },
    questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }>,
    signal?: AbortSignal,
  ): Promise<Record<string, string> | null> {
    const adapter = this.adapters.get(msg.platform);
    if (!adapter) return null;

    const timeoutMs = this.deps.userInputTimeoutMs ?? 300_000;
    const answers: Record<string, string> = {};

    // Stop typing — Po is waiting for input, not working
    await adapter.setTypingIndicator(msg.channelId, false);

    for (const q of questions) {
      const text = `**${q.header}**\n${q.question}`;

      if (adapter.sendButtons && !q.multiSelect) {
        // Use buttons for single-select
        const buttons = [
          ...q.options.map((opt, i) => ({ id: `opt_${i}`, label: opt.label })),
          { id: 'opt_other', label: 'Other' },
        ];
        const selected = await adapter.sendButtons(msg.channelId, text, buttons, {
          timeoutMs,
          userId: msg.platformUserId,
          signal,
        });

        if (selected === null) return null; // timeout or abort

        if (selected === 'Other') {
          // Ask for text input
          await adapter.sendText(msg.channelId, 'Type your answer:');
          // Wait for next text message — simple approach using a Promise + timeout
          const textAnswer = await this.awaitTextReply(msg, timeoutMs, signal);
          if (textAnswer === null) return null;
          answers[q.question] = textAnswer;
        } else {
          answers[q.question] = selected;
        }
      } else {
        // Fallback: send as text and await text reply
        const optionsText = q.options.map((o, i) => `${i + 1}. **${o.label}** — ${o.description}`).join('\n');
        await adapter.sendText(msg.channelId, `${text}\n\n${optionsText}\n\nReply with your choice:`);
        const textAnswer = await this.awaitTextReply(msg, timeoutMs, signal);
        if (textAnswer === null) return null;
        answers[q.question] = textAnswer;
      }
    }

    // Restart typing — agent is resuming
    await adapter.setTypingIndicator(msg.channelId, true);

    return answers;
  }

  private awaitTextReply(
    msg: IncomingMessage,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      let resolved = false;
      const cleanup = () => { resolved = true; };

      // Listen for next message from the same user in the same channel
      const tempHandler = (incoming: IncomingMessage) => {
        if (resolved) return;
        if (incoming.platformUserId === msg.platformUserId && incoming.channelId === msg.channelId) {
          cleanup();
          resolve(incoming.text);
        }
      };

      // Register temporary message listener on the adapter
      const adapter = this.adapters.get(msg.platform);
      if (!adapter) { resolve(null); return; }
      adapter.onMessage(tempHandler);

      // Timeout
      const timer = setTimeout(() => {
        if (!resolved) { cleanup(); resolve(null); }
      }, timeoutMs);

      // Abort signal
      if (signal) {
        signal.addEventListener('abort', () => {
          if (!resolved) { cleanup(); clearTimeout(timer); resolve(null); }
        }, { once: true });
      }
    });
  }
```

**Note:** The `awaitTextReply` approach using `adapter.onMessage` has a problem — it would replace the existing message handler. A better approach is to use a temporary message interceptor. Let the implementer use a different approach: store a pending reply resolver on the gateway keyed by `platform+channelId+userId`, and in `handleIncomingMessage`, check if there's a pending resolver before normal processing. This avoids overwriting the message handler.

Revised approach — add to the Gateway class:

```typescript
  private pendingReplies = new Map<string, (text: string) => void>();

  private awaitTextReply(
    msg: IncomingMessage,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const key = `${msg.platform}:${msg.channelId}:${msg.platformUserId}`;
      let done = false;

      const finish = (result: string | null) => {
        if (done) return;
        done = true;
        this.pendingReplies.delete(key);
        clearTimeout(timer);
        resolve(result);
      };

      this.pendingReplies.set(key, (text) => finish(text));

      const timer = setTimeout(() => finish(null), timeoutMs);

      if (signal) {
        signal.addEventListener('abort', () => finish(null), { once: true });
      }
    });
  }
```

Then, at the top of `handleIncomingMessage()`, add an early check:

```typescript
    // Check for pending follow-up reply (interactive follow-ups)
    const replyKey = `${msg.platform}:${msg.channelId}:${msg.platformUserId}`;
    const pendingReply = this.pendingReplies.get(replyKey);
    if (pendingReply) {
      pendingReply(msg.text);
      return; // Don't process as a new message
    }
```

- [ ] **Step 3: Attach requestUserInput in handleIncomingMessage**

In the `AgentRequest` construction (where `sdkSessionId` and `resumeSessionId` are set), add:

```typescript
      requestUserInput: async (questions, signal) => {
        return this.presentUserQuestions(msg, user, questions, signal);
      },
```

- [ ] **Step 4: Write gateway tests**

Add to `packages/gateway/src/__tests__/gateway.test.ts`:

```typescript
describe('Gateway — interactive follow-ups', () => {
  it('attaches requestUserInput callback to AgentRequest', async () => {
    const deps = createMockDeps();
    const gateway = new Gateway(deps);
    const adapter = createMockAdapter();
    gateway.registerAdapter(adapter);

    await adapter.simulateMessage({
      platform: 'discord', platformUserId: '123', channelId: 'ch1',
      channelType: 'dm', text: 'Hello', attachments: [], isMention: false, raw: {},
    });

    const request = (deps.executeAgentRequest as ReturnType<typeof vi.fn>).mock.calls[0][0] as AgentRequest;
    expect(request.requestUserInput).toBeDefined();
    expect(typeof request.requestUserInput).toBe('function');
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/gateway`

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/gateway.ts packages/gateway/src/__tests__/gateway.test.ts
git commit -m "feat(gateway): wire requestUserInput with Discord buttons and text fallback"
```

---

### Task 6: Wire timeout config in bootstrap + build + test

**Files:**
- Modify: `packages/main/src/bootstrap.ts`

- [ ] **Step 1: Pass userInputTimeoutMs to Gateway**

In `packages/main/src/bootstrap.ts`, find the `new Gateway({...})` constructor call. Add:

```typescript
    userInputTimeoutMs: config.agent.user_input_timeout_ms,
```

- [ ] **Step 2: Build and test**

Run: `npm run build && npm run test`

- [ ] **Step 3: Commit**

```bash
git add packages/main/src/bootstrap.ts
git commit -m "feat(main): pass user_input_timeout_ms to gateway"
```

---

### Task 7: Smoke test

- [ ] **Step 1: Build and restart**

```bash
npm run build
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
```

- [ ] **Step 2: Test in Discord**

Send Po a vague request that would trigger clarification, e.g.:
- "Create a new file" (what file? where? what content?)
- "Change the config" (which setting?)

Verify Po asks a follow-up question with buttons, and clicking a button resumes the task.

- [ ] **Step 3: Update CLAUDE.md**

Add under Important Patterns:

```
- **Interactive follow-ups:** Po can ask clarifying questions mid-task via the SDK's AskUserQuestion tool. Questions appear as Discord buttons. Configurable timeout (default 5 min) via `agent.user_input_timeout_ms`.
```

Commit:
```bash
git add CLAUDE.md
git commit -m "docs: add interactive follow-ups to CLAUDE.md"
```
