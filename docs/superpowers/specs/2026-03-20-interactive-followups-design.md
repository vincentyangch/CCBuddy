# Interactive Follow-Ups Design

**Date:** 2026-03-20
**Status:** Approved

## Overview

Enable Po to ask clarifying questions mid-task by handling the Claude Code SDK's built-in `AskUserQuestion` tool. When Claude calls it, CCBuddy presents the question in Discord (with buttons for multiple-choice, plain text for open-ended), waits for the user's reply, and feeds the answer back so Claude can continue.

This is the single biggest UX gap between CCBuddy and Claude Code — currently Po treats each Discord message independently with no ability to ask follow-up questions.

## SDK Mechanism

The Claude Code SDK has a built-in `AskUserQuestion` tool that Claude calls when it encounters ambiguity. The SDK provides a `canUseTool` callback in `query()` options:

```typescript
const result = query({
  prompt,
  options: {
    canUseTool: async ({ toolName, toolInput }) => {
      if (toolName === 'AskUserQuestion') {
        // Present questions to user, collect answers
        const answers = await presentToDiscord(toolInput.questions);
        return { behavior: 'allow', updatedInput: { ...toolInput, answers } };
      }
      return { behavior: 'allow' };
    },
  },
});
```

The SDK **blocks** on the `canUseTool` Promise — the agent pauses execution until the Promise resolves. No state serialization or manual pause/resume needed.

### AskUserQuestion Format

**Input** (from Claude):
```typescript
interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header?: string;
    options?: Array<{
      label: string;
      description?: string;
      preview?: string;
    }>;
    multiSelect?: boolean;
  }>;
}
```

**Output** (returned via `canUseTool`):
```typescript
interface AskUserQuestionOutput {
  questions: AskUserQuestionInput['questions'];
  answers: Record<string, string>; // question text → selected label(s)
}
```

- 1-4 questions per call, 2-4 options each (when structured)
- Questions can be open-ended (no `options` field) — Claude uses these for free-form input
- `multiSelect` allows selecting multiple options (labels joined with comma)

## Architecture

```
Claude (SDK) → AskUserQuestion tool call
  → canUseTool callback (SdkBackend)
    → requestUserInput callback (Gateway)
      → Discord message with buttons or text prompt
        → User clicks button / sends reply
      ← Answer string
    ← { behavior: 'allow', updatedInput: { questions, answers } }
  ← Claude continues with user's input
```

### Flow in Detail

1. **Claude calls `AskUserQuestion`** with structured questions
2. **SdkBackend's `canUseTool` fires** — checks if `toolName === 'AskUserQuestion'`
3. **SdkBackend invokes `request.requestUserInput(questions)`** — a callback provided by the gateway when constructing the `AgentRequest`
4. **Gateway formats the question for Discord:**
   - If question has `options`: send message with `ActionRowBuilder` + `ButtonBuilder` components (one button per option)
   - If question has no `options`: send plain text message, wait for next text reply from the same user
   - Multiple questions: send sequentially, collect each answer
5. **Gateway waits** for user interaction with configurable timeout (default 5 minutes):
   - Button: `message.awaitMessageComponent()` with `ComponentType.Button` filter
   - Text: `channel.awaitMessages()` filtered to same user, limit 1
6. **On response:** resolve the Promise with `answers` mapped as `{ [question.question]: selectedLabel }`
7. **On timeout:** resolve with a deny: `{ behavior: 'deny' }` — Claude proceeds without input or explains it couldn't get clarification
8. **SdkBackend returns** `{ behavior: 'allow', updatedInput: { questions, answers } }` to the SDK
9. **Claude continues** execution with the user's input

### For System/Scheduler Requests

When `permissionLevel === 'system'`, the `canUseTool` callback returns `{ behavior: 'deny' }` for `AskUserQuestion` — there is no user to ask. Claude will proceed without clarification.

## Components

### AgentRequest Changes (`packages/core/src/types/agent.ts`)

Add optional callback field:

```typescript
interface AgentRequest {
  // ... existing fields ...
  /** Callback for interactive follow-up questions. Resolves with answers or null on timeout. */
  requestUserInput?: (questions: Array<{
    question: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>) => Promise<Record<string, string> | null>;
}
```

When `null` is returned (timeout), SdkBackend returns `{ behavior: 'deny' }`.

### SdkBackend Changes (`packages/agent/src/backends/sdk-backend.ts`)

Add `canUseTool` to the `query()` options:

```typescript
if (request.requestUserInput) {
  options.canUseTool = async ({ toolName, toolInput }: any) => {
    if (toolName === 'AskUserQuestion' && request.requestUserInput) {
      const answers = await request.requestUserInput(toolInput.questions);
      if (!answers) return { behavior: 'deny' };
      return { behavior: 'allow', updatedInput: { ...toolInput, answers } };
    }
    return { behavior: 'allow' };
  };
}
```

### Gateway Changes (`packages/gateway/src/gateway.ts`)

When building the `AgentRequest` in `handleIncomingMessage()`, attach the `requestUserInput` callback:

```typescript
requestUserInput: async (questions) => {
  return this.presentUserQuestions(msg, user, questions);
},
```

New private method `presentUserQuestions()`:
1. For each question, send a Discord message via the adapter
2. If options exist: create button components, await button interaction
3. If no options: await next text message from the same user in the same channel
4. Collect answers into a `Record<string, string>`
5. Return answers, or `null` on timeout

### Platform Adapter Changes (`packages/core/src/types/platform.ts`)

Add optional method for interactive messages:

```typescript
interface PlatformAdapter {
  // ... existing methods ...
  /** Send a message with button options. Returns the selected button label, or null on timeout. */
  sendButtons?(
    channelId: string,
    text: string,
    buttons: Array<{ id: string; label: string }>,
    timeoutMs: number,
  ): Promise<string | null>;
}
```

### Discord Adapter Changes (`packages/platforms/discord/`)

Implement `sendButtons()`:
- Create `ActionRowBuilder` with `ButtonBuilder` components (up to 5 per row, up to 5 rows)
- Send the message
- Use `message.awaitMessageComponent({ componentType: ComponentType.Button, time: timeoutMs })` filtered to the requesting user
- Return the clicked button's label, or `null` on timeout
- Disable buttons after selection or timeout

### Config Addition

```yaml
agent:
  user_input_timeout_ms: 300000  # 5 minutes
```

Added to `AgentConfig` in `packages/core/src/config/schema.ts`.

## What Doesn't Change

- **SessionStore, conversation continuity** — unaffected. The `canUseTool` callback blocks within a single `query()` call; the session stays active.
- **Memory storage** — the question/answer is part of the SDK session transcript. It gets stored as part of the final `complete` response content.
- **CLI backend** — no `canUseTool` support. Interactive follow-ups only work with the SDK backend.
- **Scheduler/system requests** — auto-deny `AskUserQuestion` (no user present).
- **MCP tools, skills** — unaffected.
- **Telegram adapter** — `sendButtons` not implemented initially. Falls back: if adapter doesn't support `sendButtons`, gateway uses `sendText` + `awaitMessages` for text-only interaction.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| User doesn't reply within timeout | Return `null` → SdkBackend returns `{ behavior: 'deny' }` → Claude proceeds without input |
| Multiple questions in one call | Present sequentially, collect each answer |
| System/scheduler triggers AskUserQuestion | Auto-deny (no user present) |
| Adapter doesn't support sendButtons | Fall back to text prompt + await text reply |
| User clicks button then sends text | Button click wins (first interaction resolves the Promise) |
| Multiple AskUserQuestion calls in one session | Each one pauses independently — the `canUseTool` callback fires each time |
| Buttons overflow (>25 options) | Truncate to first 25 (Discord limit: 5 buttons × 5 rows) — unlikely since AskUserQuestion max is 4 questions × 4 options = 16 |

## Testing Strategy

- **Unit tests:** SdkBackend with mock `canUseTool` — verify it passes questions through `requestUserInput` and returns answers correctly
- **Unit tests:** Gateway `presentUserQuestions` — verify button message formatting and answer collection
- **Unit tests:** Discord adapter `sendButtons` — verify button creation and interaction handling
- **Integration test:** Full flow — mock SDK emits AskUserQuestion, verify Discord message sent, simulate button click, verify Claude receives answer
- **Edge case tests:** Timeout returns null/deny, system request auto-denies, missing sendButtons falls back to text
