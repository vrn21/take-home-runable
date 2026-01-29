# Session Lifecycle - Internal Design

## Overview

The Session Lifecycle layer orchestrates the entire flow from user input to task completion. It manages session state, Docker containers, and coordinates all other layers.

## Dependencies

```typescript
// External packages
import { anthropic } from '@ai-sdk/anthropic';
// OR: import { openai } from '@ai-sdk/openai';
import { createInterface } from 'readline';

// Internal imports (same file, referenced for clarity)
// import { startContainer, cleanupContainer } from './docker';
// import { createSession, updateSessionStatus } from './persistence';
// import { runAgent } from './agent-loop';
```

## Environment Configuration

```typescript
/**
 * Environment variables required for the agent to function.
 * Validates that required API keys are present before starting.
 */
function validateEnvironment(): void {
  const requiredVars = ['ANTHROPIC_API_KEY']; // or OPENAI_API_KEY
  const missing = requiredVars.filter(v => !process.env[v]);
  
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    console.error('Set them in .env or export before running.');
    process.exit(1);
  }
}

// Model selection based on environment
function getModel() {
  if (process.env.OPENAI_API_KEY) {
    const { openai } = require('@ai-sdk/openai');
    return openai(process.env.MODEL || 'gpt-4o');
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const { anthropic } = require('@ai-sdk/anthropic');
    return anthropic(process.env.MODEL || 'claude-3-5-sonnet-20240620');
  }
  throw new Error('No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       Session Lifecycle                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│                    ┌─────────────────────┐                              │
│                    │   CLI Entry Point   │                              │
│                    │   (stdin prompt)    │                              │
│                    └──────────┬──────────┘                              │
│                               │                                         │
│                               ▼                                         │
│                    ┌─────────────────────┐                              │
│                    │   runSession()      │                              │
│                    │   (orchestration)   │                              │
│                    └──────────┬──────────┘                              │
│                               │                                         │
│        ┌──────────────────────┼──────────────────────┐                  │
│        ▼                      ▼                      ▼                  │
│  ┌───────────┐         ┌───────────┐         ┌───────────┐             │
│  │  Create   │         │  Start    │         │  Update   │             │
│  │  Session  │         │  Docker   │         │  Status   │             │
│  └───────────┘         └───────────┘         └───────────┘             │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Main Entry Point

```typescript
import { createInterface } from 'readline';

async function main(): Promise<void> {
  console.log('Context-Compacting Coding Agent');
  console.log('================================\n');
  console.log('Enter your task (press Enter twice to submit):\n');
  
  const task = await readMultilineInput();
  
  if (!task.trim()) {
    console.error('No task provided. Exiting.');
    process.exit(1);
  }
  
  console.log('\n[Starting session...]\n');
  
  try {
    const result = await runSession(task);
    console.log('\n================================');
    console.log('Task completed!');
    console.log(`Steps executed: ${result.stepsExecuted}`);
    console.log(`\nFinal response:\n${result.finalMessage}`);
    process.exit(0);
  } catch (error) {
    console.error('\n================================');
    console.error('Session failed:', error);
    process.exit(1);
  }
}

async function readMultilineInput(): Promise<string> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    
    rl.on('line', (line) => {
      if (line === '' && lines.length > 0 && lines[lines.length - 1] === '') {
        rl.close();
        resolve(lines.slice(0, -1).join('\n'));
      } else {
        lines.push(line);
      }
    });
  });
}

main();
```

---

## Session Orchestration

```typescript
import { anthropic } from '@ai-sdk/anthropic';
// OR: import { openai } from '@ai-sdk/openai';

interface SessionResult {
  success: boolean;
  finalMessage: string;
  stepsExecuted: number;
}

async function runSession(task: string): Promise<SessionResult> {
  // 1. Create session record
  const session = await createSession(task);
  console.log(`[Session] Created: ${session.id}`);
  
  let containerId: string | null = null;
  
  try {
    // 2. Start Docker container
    containerId = await startContainer(session.id);
    console.log(`[Session] Container started: ${containerId}`);
    
    // 3. Initialize model
    const model = anthropic('claude-3-5-sonnet-20240620');
    // OR: const model = openai('gpt-4o');
    
    // 4. Run agent loop
    const result = await runAgent(session.id, task, containerId, model);
    
    // 5. Update session status
    await updateSessionStatus(session.id, 'completed');
    console.log(`[Session] Completed: ${session.id}`);
    
    return result;
    
  } catch (error) {
    // 6. Mark session as failed
    await updateSessionStatus(session.id, 'failed');
    console.error(`[Session] Failed: ${session.id}`);
    throw error;
    
  } finally {
    // 7. ALWAYS cleanup container
    if (containerId) {
      await cleanupContainer(containerId);
      console.log(`[Session] Container cleaned up`);
    }
  }
}
```

---

## Session State Management

```typescript
type SessionStatus = 'active' | 'completed' | 'failed';

async function createSession(task: string): Promise<Session> {
  const id = crypto.randomUUID();
  const now = Date.now();
  
  await db.insert(sessions).values({
    id,
    createdAt: now,
    status: 'active',
    task,
  });
  
  console.log(`[Session] Created session ${id.slice(0, 8)}...`);
  return { id, createdAt: now, status: 'active', task };
}

async function updateSessionStatus(
  sessionId: string,
  status: SessionStatus
): Promise<void> {
  await db.update(sessions)
    .set({ status })
    .where(eq(sessions.id, sessionId));
  
  console.log(`[Session] Status updated to: ${status}`);
}
```

---

## Error Handling Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Error Handling Flow                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   try {                                                                  │
│     session = createSession()     ←─ Fail here = Cannot continue        │
│     containerId = startContainer() ←─ Fail here = Session marked failed │
│     result = runAgent()           ←─ Fail here = Session marked failed  │
│     updateStatus('completed')                                            │
│   }                                                                      │
│   catch {                                                                │
│     updateStatus('failed')        ←─ Always mark failed on error        │
│     throw error                   ←─ Propagate to main()                │
│   }                                                                      │
│   finally {                                                              │
│     cleanupContainer()            ←─ ALWAYS runs, even on error         │
│   }                                                                      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Console Output Example

```text
Context-Compacting Coding Agent
================================

Enter your task (press Enter twice to submit):

Build a flashcard app like Anki with AI integration...

[Starting session...]

[Session] Created: a1b2c3d4-e5f6-7890-abcd-ef1234567890
[Session] Container started: 1a2b3c4d5e6f
[Agent] Starting with 2 messages
[prepareStep] Token count: 1245
[Docker] Executing: bun init -y...
[prepareStep] Token count: 3420
...
[Agent] Completed in 47 steps
[Session] Completed: a1b2c3d4-e5f6-7890-abcd-ef1234567890
[Session] Container cleaned up

================================
Task completed!
Steps executed: 47

Final response:
The flashcard app has been built successfully...
```

---

## Graceful Shutdown

```typescript
let currentContainerId: string | null = null;

/**
 * Handle SIGINT (Ctrl+C) and SIGTERM signals gracefully.
 * Ensures Docker container is cleaned up before exiting.
 */
function setupGracefulShutdown(): void {
  const cleanup = async (signal: string) => {
    console.log(`\n[Shutdown] Received ${signal}, cleaning up...`);
    
    if (currentContainerId) {
      await cleanupContainer(currentContainerId);
      console.log('[Shutdown] Container cleaned up');
    }
    
    process.exit(0);
  };
  
  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));
}

// Call at start of main()
// setupGracefulShutdown();
// currentContainerId = containerId; // Set when container starts
```

---

## File Location

Implement in `index.ts` within:

- **SECTION 9: SESSION LIFECYCLE** (runSession, createSession, updateSessionStatus)
- **SECTION 10: MAIN ENTRY POINT** (main, readMultilineInput, validateEnvironment, setupGracefulShutdown)

