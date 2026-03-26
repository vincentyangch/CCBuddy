# Scheduler Memory Persistence Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store the output of every scheduled prompt/skill job in the memory database as a user+assistant message pair so Po can recall what was sent in previous briefs and cron jobs.

**Architecture:** Add an optional `storeMessage` callback to `CronRunnerOptions` and `SchedulerDeps`. The runner calls it twice on success: once for the `[Scheduled: <name>]` user trigger, once for the assistant response. Bootstrap wires in `messageStore.add`. TDD throughout.

**Tech Stack:** TypeScript, Vitest, SQLite (via `MessageStore`), existing `@ccbuddy/scheduler` and `@ccbuddy/main` packages.

**Spec:** `docs/superpowers/specs/2026-03-26-scheduler-memory-persistence-design.md`

---

## Chunk 1: Types + Failing Tests

### Task 1: Add `storeMessage` to `SchedulerDeps`

**Files:**
- Modify: `packages/scheduler/src/types.ts:58-69`

- [ ] **Step 1: Add optional `storeMessage` field to `SchedulerDeps`**

  In `packages/scheduler/src/types.ts`, add after `internalJobs?`:

  ```typescript
  storeMessage?: (params: {
    userId: string;
    sessionId: string;
    platform: string;
    content: string;
    role: 'user' | 'assistant';
  }) => void | Promise<void>;
  ```

- [ ] **Step 2: Build to verify no type errors**

  ```bash
  npm run build -w packages/scheduler
  ```
  Expected: clean build, no errors.

- [ ] **Step 3: Commit**

  ```bash
  git add packages/scheduler/src/types.ts
  git commit -m "feat(scheduler): add storeMessage to SchedulerDeps type"
  ```

---

### Task 2: Write failing tests for `storeMessage` in `CronRunner`

**Files:**
- Modify: `packages/scheduler/src/__tests__/cron-runner.test.ts`

- [ ] **Step 1: Add `storeMessage` spy to `createMockDeps`**

  In `createMockDeps` (around line 41), add a `storeMessage` spy and include it in the returned object:

  ```typescript
  const storeMessage = vi.fn(async () => {});

  return {
    eventBus,
    executeAgentRequest,
    sendProactiveMessage,
    runSkill,
    assembleContext,
    timezone: 'UTC',
    storeMessage,
    ...overrides,
  };
  ```

- [ ] **Step 2: Add test — prompt job stores user+assistant pair**

  Add a new `describe` block after `'executeJob — prompt'`:

  ```typescript
  describe('executeJob — storeMessage', () => {
    it('stores user trigger and assistant response for prompt job', async () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job = createMockJob();

      await runner.executeJob(job);

      expect(deps.storeMessage).toHaveBeenCalledTimes(2);

      const calls = (deps.storeMessage as ReturnType<typeof vi.fn>).mock.calls;

      // First call: user trigger
      expect(calls[0][0]).toMatchObject({
        userId: 'user-123',
        platform: 'discord',
        role: 'user',
        content: '[Scheduled: daily-report]',
      });
      expect(calls[0][0].sessionId).toMatch(/^scheduler:cron:daily-report:\d+$/);

      // Second call: assistant response
      expect(calls[1][0]).toMatchObject({
        userId: 'user-123',
        platform: 'discord',
        role: 'assistant',
        content: 'Here is your daily report.',
      });

      // Both calls share the same sessionId
      expect(calls[0][0].sessionId).toBe(calls[1][0].sessionId);
    });

    it('stores user trigger and result for skill job', async () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job: SkillJob = {
        ...createMockJob(),
        type: 'skill',
        payload: 'check-health',
      };

      await runner.executeJob(job);

      expect(deps.storeMessage).toHaveBeenCalledTimes(2);

      const calls = (deps.storeMessage as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0]).toMatchObject({ role: 'user', content: '[Scheduled: daily-report]' });
      expect(calls[1][0]).toMatchObject({ role: 'assistant', content: 'skill-result-text' });
      expect(calls[0][0].sessionId).toMatch(/^scheduler:cron:daily-report:\d+$/);
      expect(calls[0][0].sessionId).toBe(calls[1][0].sessionId);
    });

    it('does NOT call storeMessage on error', async () => {
      const errorEvent: AgentEvent = {
        type: 'error',
        error: 'boom',
        sessionId: 'test-session',
        userId: 'user-123',
        channelId: 'general',
        platform: 'discord',
      };
      const executeAgentRequest = vi.fn(async function* (): AsyncGenerator<AgentEvent> {
        yield errorEvent;
      });
      const deps = createMockDeps({ executeAgentRequest });
      const runner = new CronRunner(deps);
      const job = createMockJob();

      await runner.executeJob(job);

      expect(deps.storeMessage).not.toHaveBeenCalled();
    });

    it('does NOT throw if storeMessage rejects', async () => {
      const storeMessage = vi.fn(async () => { throw new Error('DB down'); });
      const deps = createMockDeps({ storeMessage });
      const runner = new CronRunner(deps);
      const job = createMockJob();

      await expect(runner.executeJob(job)).resolves.not.toThrow();
      // sendProactiveMessage must still have been called (delivery unaffected)
      expect(deps.sendProactiveMessage).toHaveBeenCalledWith(
        job.target,
        'Here is your daily report.',
      );
    });

    it('works correctly when storeMessage is not provided', async () => {
      const deps = createMockDeps({ storeMessage: undefined });
      const runner = new CronRunner(deps);
      const job = createMockJob();

      await expect(runner.executeJob(job)).resolves.not.toThrow();
      expect(deps.sendProactiveMessage).toHaveBeenCalledWith(
        job.target,
        'Here is your daily report.',
      );
    });
  });
  ```

- [ ] **Step 3: Run tests — confirm they fail**

  ```bash
  npm test -w packages/scheduler -- --reporter=verbose 2>&1 | grep -E "PASS|FAIL|storeMessage"
  ```
  Expected: tests in `storeMessage` block FAIL (storeMessage not yet called).

---

## Chunk 2: Implementation + Bootstrap

### Task 3: Implement `storeMessage` in `CronRunner`

**Files:**
- Modify: `packages/scheduler/src/cron-runner.ts:10-19` (interface), `:79-111` (prompt job), `:113-127` (skill job)

- [ ] **Step 1: Add `storeMessage` to `CronRunnerOptions`**

  After the `internalJobs?` field in `CronRunnerOptions`:

  ```typescript
  storeMessage?: (params: {
    userId: string;
    sessionId: string;
    platform: string;
    content: string;
    role: 'user' | 'assistant';
  }) => void | Promise<void>;
  ```

- [ ] **Step 2: Add `storeJobMessages` private helper method**

  Add this private method to `CronRunner`:

  ```typescript
  private async storeJobMessages(
    job: PromptJob | SkillJob,
    sessionId: string,
    response: string,
  ): Promise<void> {
    if (!this.opts.storeMessage) return;
    try {
      await this.opts.storeMessage({
        userId: job.user,
        sessionId,
        platform: job.target.platform,
        content: `[Scheduled: ${job.name}]`,
        role: 'user',
      });
      await this.opts.storeMessage({
        userId: job.user,
        sessionId,
        platform: job.target.platform,
        content: response,
        role: 'assistant',
      });
    } catch (err) {
      console.warn('[Scheduler] storeMessage failed:', err);
    }
  }
  ```

- [ ] **Step 3: Call `storeJobMessages` in `executePromptJob`**

  In `executePromptJob`, after `sendProactiveMessage` and before `publishComplete`:

  ```typescript
  if (event.type === 'complete') {
    await this.opts.sendProactiveMessage(job.target, event.response);
    await this.storeJobMessages(job, sessionId, event.response);  // NEW
    await this.publishComplete(job, true);
    return;
  }
  ```

- [ ] **Step 4: Call `storeJobMessages` in `executeSkillJob`**

  In `executeSkillJob`, generate a `sessionId` and call `storeJobMessages` after sending:

  ```typescript
  private async executeSkillJob(job: SkillJob): Promise<void> {
    if (!this.opts.runSkill) {
      await this.handleError(job, 'runSkill not configured');
      return;
    }

    const sessionId = `scheduler:cron:${job.name}:${Date.now()}`;  // NEW

    try {
      const result = await this.opts.runSkill(job.payload, {});
      await this.opts.sendProactiveMessage(job.target, result);
      await this.storeJobMessages(job, sessionId, result);          // NEW
      await this.publishComplete(job, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.handleError(job, message);
    }
  }
  ```

- [ ] **Step 5: Run tests — confirm they pass**

  ```bash
  npm test -w packages/scheduler -- --reporter=verbose
  ```
  Expected: ALL tests pass including new `storeMessage` block.

- [ ] **Step 6: Commit**

  ```bash
  git add packages/scheduler/src/cron-runner.ts \
          packages/scheduler/src/__tests__/cron-runner.test.ts
  git commit -m "feat(scheduler): store job output in memory via storeMessage callback"
  ```

---

### Task 4: Thread `storeMessage` through `SchedulerService`

**Files:**
- Modify: `packages/scheduler/src/scheduler-service.ts:13-25`
- Modify: `packages/scheduler/src/__tests__/scheduler-service.test.ts`

- [ ] **Step 1: Write failing test for threading**

  Add `PromptJob` to the existing import at the top of `scheduler-service.test.ts`:
  ```typescript
  import type { PromptJob } from '../types.js';
  ```

  Then add to `scheduler-service.test.ts`, inside `describe('SchedulerService')`:

  ```typescript
  it('threads storeMessage from deps to CronRunner when provided', async () => {
    const storeMessage = vi.fn(async () => {});
    const deps = createMockDeps({ storeMessage });
    const service = new SchedulerService(deps);
    await service.start();

    // Execute the registered job to trigger storeMessage
    const jobs = service.getJobs();
    expect(jobs.length).toBeGreaterThan(0);
    const job = jobs[0] as PromptJob;
    await (service as any).cronRunner.executeJob(job);

    expect(storeMessage).toHaveBeenCalled();
    await service.stop();
  });

  it('starts cleanly when storeMessage is not provided', async () => {
    const deps = createMockDeps();
    delete (deps as any).storeMessage;
    const service = new SchedulerService(deps);
    await expect(service.start()).resolves.not.toThrow();
    await service.stop();
  });
  ```

- [ ] **Step 2: Run tests — confirm new tests fail**

  ```bash
  npm test -w packages/scheduler -- --reporter=verbose 2>&1 | grep -E "threads storeMessage|starts cleanly when"
  ```
  Expected: both new tests FAIL.

- [ ] **Step 3: Pass `storeMessage` in `SchedulerService` constructor**

  In `scheduler-service.ts`, add `storeMessage: deps.storeMessage` to the `CronRunner` constructor call:

  ```typescript
  this.cronRunner = new CronRunner({
    eventBus: deps.eventBus,
    executeAgentRequest: deps.executeAgentRequest,
    sendProactiveMessage: deps.sendProactiveMessage,
    runSkill: deps.runSkill,
    timezone: deps.config.scheduler.timezone,
    defaultModel: deps.defaultModel,
    assembleContext: deps.assembleContext,
    internalJobs: deps.internalJobs,
    storeMessage: deps.storeMessage,  // NEW
  });
  ```

- [ ] **Step 4: Run all scheduler tests — confirm all pass**

  ```bash
  npm test -w packages/scheduler -- --reporter=verbose
  ```
  Expected: ALL tests pass.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/scheduler/src/scheduler-service.ts \
          packages/scheduler/src/__tests__/scheduler-service.test.ts
  git commit -m "feat(scheduler): thread storeMessage through SchedulerService"
  ```

---

### Task 5: Wire `storeMessage` in Bootstrap + Build + Restart

**Files:**
- Modify: `packages/main/src/bootstrap.ts:463-495`

- [ ] **Step 1: Pass `storeMessage` to `SchedulerService`**

  In the `SchedulerService` constructor call (around line 463), add `storeMessage`:

  ```typescript
  const schedulerService = new SchedulerService({
    config,
    eventBus,
    defaultModel: config.agent.model,
    executeAgentRequest: (request) => agentService.handleRequest({ ... }),
    sendProactiveMessage,
    runSkill: undefined,
    assembleContext: (userId, sessionId) => { ... },
    checkDatabase: async () => { ... },
    checkAgent: async () => { ... },
    internalJobs,
    storeMessage: (params) => {                    // NEW — block body: avoids implicitly returning number
      messageStore.add({
        userId: params.userId,
        sessionId: params.sessionId,
        platform: params.platform,
        content: params.content,
        role: params.role,
      });
    },
  });
  ```

- [ ] **Step 2: Build all packages**

  ```bash
  npm run build
  ```
  Expected: clean build, no TypeScript errors.

- [ ] **Step 3: Run all tests**

  ```bash
  npm test
  ```
  Expected: all tests pass.

- [ ] **Step 4: Commit**

  ```bash
  git add packages/main/src/bootstrap.ts
  git commit -m "feat(main): wire storeMessage into SchedulerService for job memory persistence"
  ```

- [ ] **Step 5: Restart CCBuddy**

  ```bash
  launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
  ```

- [ ] **Step 6: Verify in memory DB after next brief**

  After the next scheduled job fires, confirm messages are stored:

  ```bash
  sqlite3 /Users/flyingchickens/Documents/Projects/CCBuddy/data/memory.sqlite \
    "SELECT role, substr(content,1,80), datetime(timestamp/1000,'unixepoch') \
     FROM messages WHERE content LIKE '[Scheduled:%' OR sessionId LIKE 'scheduler:%' \
     ORDER BY timestamp DESC LIMIT 10;"
  ```
  Expected: rows with `role=user` (`[Scheduled: ...]`) and `role=assistant` (brief content).
