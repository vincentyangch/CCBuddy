# Reminders Create List Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `apple_reminders_create_list` MCP tool that creates a new Apple Reminders list, then uses it to seed the "CCBuddy Open Items" list with current open items.

**Architecture:** Three-layer change — Swift binary (EventKit), TypeScript service wrapper, MCP server handler — followed by a binary rebuild and list seeding.

**Tech Stack:** Swift (EventKit, ArgumentParser), TypeScript (Node.js), Vitest

---

## Task 1: Add Swift `RemindersCreateList` command

**Files:**
- Modify: `swift-helper/Sources/CCBuddyHelper/RemindersCommands.swift` (end of file)
- Modify: `swift-helper/Sources/CCBuddyHelper/main.swift:32-37`

- [ ] **Step 1: Add `RemindersCreateList` struct to RemindersCommands.swift**

  Append after the `RemindersDelete` struct (line 208):

  ```swift
  // MARK: - Create List

  struct RemindersCreateList: ParsableCommand {
      static let configuration = CommandConfiguration(commandName: "create-list")

      @Option(help: "List name")
      var name: String

      func run() throws {
          try requestRemindersAccess()

          let reminderCalendars = reminderStore.calendars(for: .reminder)
          if reminderCalendars.first(where: { $0.title == name }) != nil {
              printError("Reminder list '\(name)' already exists.")
              return
          }

          let calendar = EKCalendar(for: .reminder, eventStore: reminderStore)
          calendar.title = name
          // Use the same source as the default reminders calendar
          if let source = reminderStore.defaultCalendarForNewReminders()?.source {
              calendar.source = source
          }

          try reminderStore.saveCalendar(calendar, commit: true)
          printJSON(SuccessResult(success: true))
      }
  }
  ```

- [ ] **Step 2: Register the new subcommand in main.swift**

  Update `RemindersCommand` subcommands array (currently lines 32-37) to add `RemindersCreateList.self`:

  ```swift
  struct RemindersCommand: ParsableCommand {
      static let configuration = CommandConfiguration(
          commandName: "reminders",
          abstract: "Reminders operations",
          subcommands: [
              RemindersList.self,
              RemindersCreate.self,
              RemindersComplete.self,
              RemindersDelete.self,
              RemindersCreateList.self,
          ]
      )
  }
  ```

- [ ] **Step 3: Build the Swift binary to verify it compiles**

  ```bash
  cd ~/Projects/CCBuddy/swift-helper && swift build -c release 2>&1
  ```

  Expected: `Build complete!` with no errors.

- [ ] **Step 4: Smoke-test the new command**

  ```bash
  ~/Projects/CCBuddy/swift-helper/.build/release/ccbuddy-helper reminders create-list --name "Test List"
  ```

  Expected JSON: `{ "success": true }`

  Then verify list exists and clean up:

  ```bash
  ~/Projects/CCBuddy/swift-helper/.build/release/ccbuddy-helper reminders list --list "Test List"
  ```

  Expected: empty reminders list, no error.

---

## Task 2: TypeScript service method + tests

**Files:**
- Modify: `packages/apple/src/reminders-service.ts`
- Modify: `packages/apple/src/__tests__/reminders-service.test.ts`

- [ ] **Step 1: Write the failing test first**

  Add a new `describe('createList()')` block to `reminders-service.test.ts` (after the `deleteReminder` block, before `getToolDefinitions`):

  ```typescript
  describe('createList()', () => {
    it('calls bridge with create-list args', async () => {
      bridge.exec.mockResolvedValue({ success: true });

      await service.createList('CCBuddy Open Items');

      expect(bridge.exec).toHaveBeenCalledWith([
        'reminders', 'create-list', '--name', 'CCBuddy Open Items',
      ]);
    });

    it('throws when bridge returns error', async () => {
      bridge.exec.mockResolvedValue({ success: false, error: 'List already exists' });

      await expect(service.createList('Reminders')).rejects.toThrow('List already exists');
    });
  });
  ```

  Also update the `getToolDefinitions()` test to expect 5 tools:

  ```typescript
  it('returns 5 tool definitions', () => {
    const tools = service.getToolDefinitions();
    expect(tools).toHaveLength(5);
    const names = tools.map(t => t.name);
    expect(names).toContain('apple_reminders_create_list');
  });
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  ```bash
  cd ~/Projects/CCBuddy && npm test -w packages/apple 2>&1 | tail -20
  ```

  Expected: 3 failing tests (`createList` × 2, `getToolDefinitions` count).

- [ ] **Step 3: Implement `createList()` in reminders-service.ts**

  Add after `deleteReminder()` (before `getToolDefinitions()`):

  ```typescript
  async createList(name: string): Promise<void> {
    const result = await this.bridge.exec(['reminders', 'create-list', '--name', name]);
    this.assertSuccess(result);
  }
  ```

  Add the new tool definition inside `getToolDefinitions()` return array (after `apple_reminders_delete`):

  ```typescript
  {
    name: 'apple_reminders_create_list',
    description: 'Create a new Apple Reminders list.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the new reminders list' },
      },
      required: ['name'],
    },
  },
  ```

- [ ] **Step 4: Run tests — confirm all pass**

  ```bash
  cd ~/Projects/CCBuddy && npm test -w packages/apple 2>&1 | tail -20
  ```

  Expected: all tests pass, no failures.

---

## Task 3: MCP server handler

**Files:**
- Modify: `packages/skills/src/mcp-server.ts`

- [ ] **Step 1: Add handler after the `apple_reminders_delete` block (~line 906)**

  ```typescript
  // ── apple_reminders_create_list ───────────────────────────────────────
  if (remindersService && name === 'apple_reminders_create_list') {
    await remindersService.createList(toolArgs.name as string);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
  }
  ```

- [ ] **Step 2: Build to verify no TypeScript errors**

  ```bash
  cd ~/Projects/CCBuddy && npm run build -w packages/apple -w packages/skills 2>&1 | tail -20
  ```

  Expected: build completes with no errors.

---

## Task 4: Seed the list and update evening briefing

- [ ] **Step 1: Create "CCBuddy Open Items" list via the new Swift command**

  ```bash
  ~/Projects/CCBuddy/swift-helper/.build/release/ccbuddy-helper reminders create-list --name "CCBuddy Open Items"
  ```

  Expected: `{ "success": true }`

- [ ] **Step 2: Seed open items into the list**

  ```bash
  BIN=~/Projects/CCBuddy/swift-helper/.build/release/ccbuddy-helper

  $BIN reminders create --title "Scheduler memory persistence" \
    --list "CCBuddy Open Items" \
    --notes "Briefings sent via sendProactiveMessage bypass DB storage. Design spec at docs/superpowers/specs/2026-03-26-scheduler-memory-persistence-design.md — implementation not working."

  $BIN reminders create --title "Home network scan skill — times out" \
    --list "CCBuddy Open Items" \
    --notes "Subnet scan exceeds 120s timeout. No fix attempted."

  $BIN reminders create --title "GitHub PAT — needs rotation" \
    --list "CCBuddy Open Items" \
    --notes "Classic personal access token flagged as expiring. Rotate at github.com/settings/tokens."
  ```

- [ ] **Step 3: Verify all 3 reminders are in the list**

  ```bash
  ~/Projects/CCBuddy/swift-helper/.build/release/ccbuddy-helper reminders list --list "CCBuddy Open Items"
  ```

  Expected: JSON with 3 reminders.

- [ ] **Step 4: Update evening briefing prompt in config/local.yaml**

  Replace the Apple Notes instructions in section 3 with Reminders-based instructions:

  ```yaml
  3. **Open items** — use apple_reminders_list with list="CCBuddy Open Items" to read current open items. Then:
     - Add any newly raised unresolved issues from today's conversations as new reminders (use apple_reminders_create with list="CCBuddy Open Items").
     - Complete any items resolved today (use apple_reminders_complete with the reminder's id).
     - In the briefing, list the current open items. If nothing changed, say so briefly.
  ```

- [ ] **Step 5: Restart CCBuddy to pick up new binary + MCP tools**

  ```bash
  launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
  ```
