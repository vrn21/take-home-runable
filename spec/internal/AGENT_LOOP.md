# Agent Loop - Internal Design

## Overview

The Agent Loop orchestrates LLM interactions using Vercel AI SDK's `generateText` with `maxSteps`. It handles tool execution, message persistence, and context compaction integration.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Agent Loop                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    generateText()                                 │   │
│  │  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐             │   │
│  │  │ prepareStep │──▶│  LLM Call   │──▶│onStepFinish │             │   │
│  │  │ (compact?)  │   │             │   │ (persist)   │             │   │
│  │  └─────────────┘   └─────────────┘   └─────────────┘             │   │
│  │         │                │                  │                     │   │
│  │         │                ▼                  │                     │   │
│  │         │         ┌─────────────┐           │                     │   │
│  │         │         │Tool Calls?  │──yes──▶ Execute ──┐             │   │
│  │         │         └─────────────┘                   │             │   │
│  │         │                │ no                       │             │   │
│  │         │                ▼                          ▼             │   │
│  │         │           Return result              Next step          │   │
│  └─────────┴───────────────────────────────────────────┴─────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Message Initialization

Before starting the loop, seed system and user messages:

```typescript
import type { CoreMessage } from 'ai';

const SYSTEM_PROMPT = `You are a coding agent that builds software by executing commands and managing files.

ENVIRONMENT:
- All commands run inside a Docker container with Bun installed
- Working directory is /workspace
- You have full shell access via execute_command
- You can read/write files and list directories

APPROACH:
1. Understand the task requirements fully before starting
2. Break complex tasks into smaller, testable steps
3. Create files incrementally, testing as you go
4. Use execute_command to run tests, install dependencies, etc.
5. If something fails, read the error and fix it

STYLE:
- Write clean, idiomatic code
- Follow language/framework conventions
- Test your work before declaring completion

CONSTRAINTS:
- Do not ask clarifying questions - make reasonable assumptions
- Focus on implementation, minimize explanation`;

async function initializeMessages(sessionId: string, task: string): Promise<CoreMessage[]> {
  // Save system message
  await saveMessage(sessionId, 'system', SYSTEM_PROMPT, estimateTokens(SYSTEM_PROMPT));
  
  // Save user message
  await saveMessage(sessionId, 'user', task, estimateTokens(task));
  
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: task },
  ];
}
```

---

## Main Agent Loop

> [!IMPORTANT]
> In Vercel AI SDK v4, when using `messages` array, the system prompt should be the first message in the array with `role: 'system'`. Do NOT pass both `system` param and a system message - this causes duplication.

```typescript
import { generateText, type CoreMessage, type LanguageModel } from 'ai';

interface AgentResult {
  success: boolean;
  finalMessage: string;
  stepsExecuted: number;
}

async function runAgent(
  sessionId: string,
  task: string,
  containerId: string,
  model: LanguageModel
): Promise<AgentResult> {
  // Load or initialize messages (includes system message at index 0)
  let messages = await loadActiveMessages(sessionId);
  if (messages.length === 0) {
    messages = await initializeMessages(sessionId, task);
  }
  
  console.log(`[Agent] Starting with ${messages.length} messages`);
  
  // NOTE: Do NOT pass 'system' parameter when using messages array
  // The system message is already messages[0]
  const result = await generateText({
    model,
    messages,  // System prompt is messages[0]
    tools: createTools(containerId),
    maxSteps: 50,
    
    prepareStep: async ({ messages: stepMessages }) => {
      // Check for compaction before each step
      if (shouldCompact(stepMessages)) {
        console.log('[Agent] Triggering compaction...');
        const compacted = await safeCompact(stepMessages, sessionId, model);
        return { messages: compacted };
      }
      return { messages: stepMessages };
    },
    
    onStepFinish: async ({ response }) => {
      // Persist new messages from this step
      await persistStepMessages(sessionId, response.messages);
    },
  });
  
  const finalText = result.text || 'Task completed.';
  console.log(`[Agent] Completed in ${result.steps.length} steps`);
  
  return {
    success: true,
    finalMessage: finalText,
    stepsExecuted: result.steps.length,
  };
}
```

---

## prepareStep Hook

```typescript
type PrepareStepParams = {
  messages: CoreMessage[];
  toolCallId?: string;
};

type PrepareStepResult = {
  messages: CoreMessage[];
};

async function prepareStepCallback(
  params: PrepareStepParams,
  sessionId: string,
  model: LanguageModel
): Promise<PrepareStepResult> {
  const { messages } = params;
  
  // Check token count against threshold
  const tokenCount = estimateMessagesTokens(messages);
  console.log(`[prepareStep] Token count: ${tokenCount}`);
  
  if (shouldCompact(messages)) {
    console.log('[prepareStep] Threshold exceeded, compacting...');
    const compacted = await safeCompact(messages, sessionId, model);
    return { messages: compacted };
  }
  
  return { messages };
}
```

---

## onStepFinish Hook

```typescript
import type { StepResult } from 'ai';

async function persistStepMessages(
  sessionId: string,
  newMessages: CoreMessage[]
): Promise<void> {
  for (const msg of newMessages) {
    const content = serializeMessageContent(msg);
    const tokens = estimateTokens(content);
    await saveMessage(sessionId, msg.role, content, tokens);
  }
}

function serializeMessageContent(msg: CoreMessage): string {
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  
  // Handle complex content (tool calls, etc.)
  if (msg.role === 'assistant' && 'toolCalls' in msg) {
    return JSON.stringify({
      text: msg.content,
      toolCalls: msg.toolCalls,
    });
  }
  
  if (msg.role === 'tool') {
    return JSON.stringify({
      toolCallId: msg.toolCallId,
      content: msg.content,
    });
  }
  
  return JSON.stringify(msg.content);
}
```

---

## Stop Conditions

| Condition | Detection | Behavior |
|-----------|-----------|----------|
| Max steps reached | `steps.length >= maxSteps` | Return result |
| No tool calls | LLM returns text only | Task complete |
| Explicit completion | LLM says "done" | Task complete |
| Fatal error | Exception thrown | Propagate error |

```typescript
// Stop condition is handled internally by generateText
// when no more tool calls are made or maxSteps is reached
```

---

## Error Handling in Agent Loop

```typescript
async function runAgentWithErrorHandling(
  sessionId: string,
  task: string,
  containerId: string,
  model: LanguageModel
): Promise<AgentResult> {
  try {
    return await runAgent(sessionId, task, containerId, model);
  } catch (error) {
    console.error(`[Agent] Error: ${error}`);
    
    // Log final state for debugging
    const messages = await getActiveMessages(sessionId);
    console.error(`[Agent] Final message count: ${messages.length}`);
    
    throw error;
  }
}
```

---

## Console Output Pattern

```
[Agent] Starting with 2 messages
[prepareStep] Token count: 1245
[Docker] Executing: bun init...
[prepareStep] Token count: 3420
[Docker] Executing: cat package.json...
...
[prepareStep] Token count: 95000
[Agent] Triggering compaction...
[Compaction] Round 1: 95000 → 2500 tokens (45 messages summarized)
...
[Agent] Completed in 47 steps
```

---

## File Location

Implement in `index.ts` within **SECTION 8: AGENT LOOP**.
