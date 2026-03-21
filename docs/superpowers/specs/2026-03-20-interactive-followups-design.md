# Interactive Follow-Ups Design

**Date:** 2026-03-20
**Status:** Approved

## Overview

Enable Po to ask clarifying questions mid-task by handling the Claude Code SDK's built-in `AskUserQuestion` tool. When Claude calls it, CCBuddy presents the question in Discord with buttons (including an "Other" button for free-form input), waits for the user's reply, and feeds the answer back so Claude can continue.

This is the single biggest UX gap between CCBuddy and Claude Code — currently Po treats each Discord message independently with no ability to ask follow-up questions.

## SDK Mechanism

The Claude Code SDK has a built-in `AskUserQuestion` tool that Claude calls when it encounters ambiguity. The SDK provides a `canUseTool` callback in `query()` options:

```typescript
const result = query({
  prompt,
  options: {
    // canUseTool uses positional args: (toolName, input, options)
    canUseTool: async (toolName, input, { signal }) => {
      if (toolName === 'AskUserQuestion') {
        const answers = await presentToDiscord(input.questions, signal);
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      }
      return { behavior: 'allow' };
    },
  },
});
```

The SDK **blocks** on the `canUseTool` Promise — the agent pauses execution until the Promise resolves. No state serialization or manual pause/resume needed.

### AskUserQuestion Format

**Input** (from Claude) — all fields are required:
```typescript
interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header: string;      // required, displayed above the question
    options: Array<{     // required, always 2-4 options
      label: string;     // 1-5 words
      description: string; // required, explains the option
      preview?: string;
    }>;
    multiSelect: boolean; // required
  }>;
}
```

**Output** (returned via `canUseTool`'s `updatedInput`):
```typescript
interface AskUserQuestionOutput {
  questions: AskUserQuestionInput['questions'];
  answers: Record<string, string>; // question text → selected label(s)
}
```

- 1-4 questions per call, 2-4 options each
- All questions have structured options — there are no open-ended questions in this tool
- `multiSelect: true` allows selecting multiple options (labels joined with comma)
- An "Other" option is auto-provided by Claude Code's UI — CCBuddy must add its own "Other" button that triggers a text input flow
- The `annotations` field exists on the output type but is deferred for v1

## Architecture

```
Claude (SDK) → AskUserQuestion tool call
  → canUseTool(toolName, input, { signal }) (SdkBackend)
    → requestUserInput callback (Gateway)
      → Discord message with buttons + "Other" button
        → User clicks button / types custom reply via "Other"
      ← Answer string
    ← { behavior: 'allow', updatedInput: { questions, answers } }
  ← Claude continues with user's input
```

### Flow in Detail

1. **Claude calls `AskUserQuestion`** with structured questions (always has options)
2. **SdkBackend's `canUseTool` fires** with positional args `(toolName, input, options)` — checks if `toolName === 'AskUserQuestion'`
3. **SdkBackend invokes `request.requestUserInput(questions, signal)`** — a callback provided by the gateway when constructing the `AgentRequest`
4. **Gateway formats each question for Discord:**
   - Creates `ActionRowBuilder` with `ButtonBuilder` for each option + an "Other" button
   - Header and descriptions shown in an embed above the buttons
   - For `multiSelect`: uses `StringSelectMenuBuilder` with `setMaxValues()` instead of buttons
5. **Gateway waits** for user interaction with configurable timeout (default 5 minutes):
   - Button: `message.awaitMessageComponent({ componentType: ComponentType.Button, time: timeoutMs })` filtered to the requesting user
   - "Other" button: sends a follow-up "Type your answer:" prompt, awaits next text message
   - `StringSelectMenu`: `message.awaitMessageComponent({ componentType: ComponentType.StringSelect })` for multi-select
   - Also listens to `signal.addEventListener('abort', ...)` to cancel the wait if the SDK aborts
6. **On response:** resolve the Promise with `answers` mapped as `{ [question.question]: selectedLabel }`
7. **On timeout or abort:** return `null` → SdkBackend returns `{ behavior: 'deny', message: 'User did not respond within the timeout period' }`
8. **SdkBackend returns** `{ behavior: 'allow', updatedInput: { questions, answers } }` to the SDK
9. **Claude continues** execution with the user's input
10. **Buttons disabled** after selection or timeout to prevent stale interactions

### Typing Indicator

The gateway should stop the typing indicator when presenting a follow-up question (Po is waiting, not working). After the user answers and the agent resumes, restart the typing indicator.

### For System/Scheduler Requests

When `permissionLevel === 'system'`, the `canUseTool` callback returns `{ behavior: 'deny', message: 'No user present for system requests' }` for `AskUserQuestion` — there is no user to ask. Claude will proceed without clarification.

## Components

### AgentRequest Changes (`packages/core/src/types/agent.ts`)

Add optional callback field:

```typescript
interface AgentRequest {
  // ... existing fields ...
  /** Callback for interactive follow-up questions. Resolves with answers or null on timeout/abort. */
  requestUserInput?: (
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect: boolean;
    }>,
    signal?: AbortSignal,
  ) => Promise<Record<string, string> | null>;
}
```

When `null` is returned (timeout/abort), SdkBackend returns `{ behavior: 'deny', message: '...' }`.

### SdkBackend Changes (`packages/agent/src/backends/sdk-backend.ts`)

Add `canUseTool` to the `query()` options:

```typescript
if (request.requestUserInput) {
  options.canUseTool = async (toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal }) => {
    if (toolName === 'AskUserQuestion' && request.requestUserInput) {
      const answers = await request.requestUserInput(input.questions as any, opts.signal);
      if (!answers) return { behavior: 'deny', message: 'User did not respond within the timeout period' };
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }
    return { behavior: 'allow' };
  };
}
```

For system requests (no `requestUserInput` provided), `canUseTool` is not set — the SDK's default behavior applies.

### Gateway Changes (`packages/gateway/src/gateway.ts`)

When building the `AgentRequest` in `handleIncomingMessage()`, attach the `requestUserInput` callback:

```typescript
requestUserInput: async (questions, signal) => {
  return this.presentUserQuestions(msg, user, questions, signal);
},
```

New private method `presentUserQuestions()`:
1. Stop typing indicator
2. For each question:
   - If `multiSelect`: create `StringSelectMenuBuilder` with options + max values
   - Otherwise: create `ButtonBuilder` for each option + an "Other" button
   - Send with embed showing header + option descriptions
   - Await interaction (respecting both timeout and abort signal)
   - If "Other" clicked: send "Type your answer:" and await text message
3. Collect answers into `Record<string, string>`
4. Restart typing indicator
5. Return answers, or `null` on timeout/abort
6. Disable buttons/menus on completion

### Platform Adapter Changes (`packages/core/src/types/platform.ts`)

Add optional methods for interactive messages:

```typescript
interface PlatformAdapter {
  // ... existing methods ...
  /** Send a message with button options. Returns the selected label, or null on timeout. */
  sendButtons?(
    channelId: string,
    text: string,
    buttons: Array<{ id: string; label: string; description: string }>,
    options: { timeoutMs: number; userId?: string; signal?: AbortSignal },
  ): Promise<string | null>;

  /** Send a select menu for multi-select. Returns selected labels, or null on timeout. */
  sendSelectMenu?(
    channelId: string,
    text: string,
    options: Array<{ value: string; label: string; description: string }>,
    opts: { timeoutMs: number; maxValues: number; userId?: string; signal?: AbortSignal },
  ): Promise<string[] | null>;
}
```

### Discord Adapter Changes (`packages/platforms/discord/`)

Implement `sendButtons()`:
- Create `ActionRowBuilder` with `ButtonBuilder` components (up to 5 per row)
- Add "Other" button with secondary style
- Send the message with an embed for the question header
- Use `message.awaitMessageComponent({ componentType: ComponentType.Button, time: timeoutMs, filter: i => i.user.id === userId })`
- If "Other" selected: send follow-up prompt, `channel.awaitMessages({ filter, max: 1, time: remainingTimeout })`
- Disable all buttons after selection or timeout
- Listen to `signal.abort` to cancel the collector
- Return the clicked button's label (or typed text for "Other"), or `null` on timeout

Implement `sendSelectMenu()`:
- Create `StringSelectMenuBuilder` with options
- Similar await/disable/abort pattern
- Return array of selected labels

### Config Addition

```yaml
agent:
  user_input_timeout_ms: 300000  # 5 minutes
```

Added to `AgentConfig` in `packages/core/src/config/schema.ts`.

## What Doesn't Change

- **SessionStore, conversation continuity** — unaffected. The `canUseTool` callback blocks within a single `query()` call; the session stays active.
- **Memory storage** — the question/answer is part of the SDK session transcript. Stored as part of the final response.
- **CLI backend** — no `canUseTool` support. Interactive follow-ups only work with the SDK backend.
- **Scheduler/system requests** — `requestUserInput` not provided → `canUseTool` not set → SDK default.
- **MCP tools, skills** — unaffected.
- **Telegram adapter** — `sendButtons`/`sendSelectMenu` not implemented initially. Falls back: gateway uses `sendText` + awaits next text message for any question.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| User doesn't reply within timeout | Return `null` → `{ behavior: 'deny', message: '...' }` → Claude proceeds without input |
| SDK aborts during wait | `signal.abort` fires → cancel collector → return `null` → deny |
| Multiple questions in one call | Present sequentially, collect each answer |
| System/scheduler triggers AskUserQuestion | `canUseTool` not set → SDK default behavior |
| Adapter doesn't support sendButtons | Fall back to `sendText` + await text reply |
| User clicks "Other" | Prompt for text input, await next message, use that as the answer |
| `multiSelect` question | Use `StringSelectMenuBuilder` instead of buttons |
| Multiple AskUserQuestion calls in one session | Each pauses independently — `canUseTool` fires each time |
| Discord button label >80 chars | Truncate with ellipsis (unlikely: SDK labels are 1-5 words) |

## Testing Strategy

- **Unit tests:** SdkBackend with mock `canUseTool` — verify positional args, answers pass through, timeout returns deny with message
- **Unit tests:** Gateway `presentUserQuestions` — verify button formatting, "Other" flow, timeout handling, signal abort
- **Unit tests:** Discord adapter `sendButtons` — verify button creation, interaction filtering, disable after use
- **Integration test:** Full flow — mock SDK emits AskUserQuestion, verify Discord message sent, simulate button click, verify Claude receives answer
- **Edge case tests:** Timeout returns null/deny with message, system request has no canUseTool, missing sendButtons falls back to text, abort signal cancels wait
