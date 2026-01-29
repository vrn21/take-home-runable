# Context Compaction Layer - Internal Design

## Overview

The Context Compaction Layer is responsible for automatically summarizing conversation history when the token count approaches the model's context window limit. This prevents context overflow errors during long-running agent sessions.

## Dependencies

- **Token Estimator**: Heuristic function for counting tokens
- **LLM Provider**: Same model used for agent tasks (Claude/GPT-4)
- **Persistence Layer**: For recording compaction events

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                       Context Compaction Layer                           │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐       │
│  │ estimateTokens  │───▶│  shouldCompact  │───▶│    compact      │       │
│  │   (heuristic)   │    │                 │    │                 │       │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘       │
│                                                        │                 │
│                         ┌──────────────────────────────┤                 │
│                         ▼                              ▼                 │
│              ┌─────────────────┐            ┌─────────────────┐          │
│              │selectMessages   │            │generateSummary  │          │
│              │ToCompact        │            │                 │          │
│              └─────────────────┘            └─────────────────┘          │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Token Estimation

### Function Signature

```typescript
function estimateTokens(text: string): number
```

### Implementation

Use a simple character-based heuristic as explicitly permitted by requirements:

```typescript
/**
 * Estimate token count using character-based heuristic.
 * Formula: ~4 characters per token (conservative estimate).
 * 
 * This slightly over-counts to ensure we never exceed context limits.
 * Accuracy: ~75-80% for English text, sufficient for threshold detection.
 */
function estimateTokens(text: string): number {
  if (!text || typeof text !== 'string') {
    return 0;
  }
  return Math.ceil(text.length / 4);
}
```

### Message Array Token Counting

```typescript
import type { CoreMessage } from 'ai';

/**
 * Estimate total tokens across all messages in the array.
 * Handles all message types: system, user, assistant, tool.
 */
function estimateMessagesTokens(messages: CoreMessage[]): number {
  let total = 0;
  
  for (const message of messages) {
    // Role contributes ~2 tokens
    total += 2;
    
    if (typeof message.content === 'string') {
      total += estimateTokens(message.content);
    } else if (Array.isArray(message.content)) {
      // Handle content parts (text, tool_call, tool_result)
      for (const part of message.content) {
        if (part.type === 'text') {
          total += estimateTokens(part.text);
        } else if (part.type === 'tool-call') {
          total += estimateTokens(part.toolName);
          total += estimateTokens(JSON.stringify(part.args));
        } else if (part.type === 'tool-result') {
          total += estimateTokens(JSON.stringify(part.result));
        }
      }
    }
    
    // Handle assistant messages with tool_calls
    if (message.role === 'assistant' && 'toolCalls' in message) {
      for (const toolCall of message.toolCalls || []) {
        total += estimateTokens(toolCall.toolName);
        total += estimateTokens(JSON.stringify(toolCall.args));
      }
    }
  }
  
  return total;
}
```

### Rationale

| Approach | Pros | Cons |
|----------|------|------|
| **Character-based (chosen)** | Fast, no dependencies, works across models | ~20-25% variance |
| tiktoken library | Accurate for OpenAI | Extra dependency, model-specific |
| API call | Exact count | Latency, cost, rate limits |

The character-based approach is explicitly permitted ("simple heuristic is fine") and its conservative nature (over-counting) ensures safety.

---

## Compaction Threshold Configuration

### Constants

```typescript
interface CompactionConfig {
  modelContextLimit: number;    // Total tokens model supports
  systemReserve: number;        // Reserved for system prompt + tools
  outputReserve: number;        // Reserved for model response
  safetyBuffer: number;         // Heuristic variance buffer
  thresholdPercent: number;     // Trigger at this % of available
  recentMessagesToKeep: number; // Messages preserved during compaction
}

const DEFAULT_CONFIG: CompactionConfig = {
  modelContextLimit: 128_000,   // GPT-4o / GPT-4-turbo
  systemReserve: 2_000,
  outputReserve: 4_000,
  safetyBuffer: 5_000,
  thresholdPercent: 0.80,
  recentMessagesToKeep: 10,
};

// Pre-calculate threshold
function calculateThreshold(config: CompactionConfig): number {
  const available = config.modelContextLimit 
    - config.systemReserve 
    - config.outputReserve 
    - config.safetyBuffer;
  return Math.floor(available * config.thresholdPercent);
}

// For default config: (128000 - 2000 - 4000 - 5000) * 0.80 = 93,600 tokens
const COMPACTION_THRESHOLD = calculateThreshold(DEFAULT_CONFIG);
```

### Model-Specific Limits

```typescript
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'claude-3-5-sonnet-20240620': 200_000,
  'claude-3-haiku-20240307': 200_000,
};

function getContextLimit(modelId: string): number {
  return MODEL_CONTEXT_LIMITS[modelId] ?? 128_000; // Default fallback
}
```

---

## Compaction Trigger Logic

### Function Signature

```typescript
function shouldCompact(
  messages: CoreMessage[],
  config?: CompactionConfig
): boolean
```

### Implementation

```typescript
/**
 * Determine if compaction should be triggered.
 * Called at the start of each agent step via prepareStep.
 */
function shouldCompact(
  messages: CoreMessage[],
  config: CompactionConfig = DEFAULT_CONFIG
): boolean {
  // Empty or minimal messages - nothing to compact
  if (messages.length <= config.recentMessagesToKeep + 1) {
    return false;
  }
  
  const tokenCount = estimateMessagesTokens(messages);
  const threshold = calculateThreshold(config);
  
  return tokenCount >= threshold;
}
```

### Decision Flow

```
                    ┌─────────────────────┐
                    │   shouldCompact()   │
                    │   called            │
                    └─────────────────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │ messages.length <=  │──yes──▶ Return false
                    │ keepLast + 1 ?      │        (nothing to compact)
                    └─────────────────────┘
                              │ no
                              ▼
                    ┌─────────────────────┐
                    │ Estimate total      │
                    │ token count         │
                    └─────────────────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │ tokens >= threshold │
                    │        ?            │
                    └─────────────────────┘
                        │           │
                       yes          no
                        │           │
                        ▼           ▼
                   Return true  Return false
```

---

## Message Selection Algorithm

### Function Signature

```typescript
interface CompactionSelection {
  messagesToCompact: CoreMessage[];  // These will be summarized
  messagesToKeep: CoreMessage[];     // These stay as-is
  previousSummary: string | null;    // From previous compaction
}

function selectMessagesToCompact(
  messages: CoreMessage[],
  keepLast: number = 10
): CompactionSelection
```

### Implementation

```typescript
import type { CoreMessage } from 'ai';

/**
 * Select which messages to compact and which to preserve.
 * 
 * CRITICAL: Tool calls and their results must stay together.
 * Orphaned tool messages break the LLM's understanding of state.
 */
function selectMessagesToCompact(
  messages: CoreMessage[],
  keepLast: number = 10
): CompactionSelection {
  // Nothing to compact if too few messages
  if (messages.length <= keepLast + 1) {
    return {
      messagesToCompact: [],
      messagesToKeep: messages,
      previousSummary: null,
    };
  }

  // System message is always at index 0 and always kept
  const systemMessage = messages[0];
  
  // Calculate initial boundary for recent messages
  let boundaryIndex = messages.length - keepLast;
  
  // Adjust boundary to not orphan tool results
  // Walk backward if we're about to split a tool call/result pair
  while (boundaryIndex > 1 && messages[boundaryIndex]?.role === 'tool') {
    boundaryIndex--;
  }

  // Check if there's a previous summary (index 1, from prior compaction)
  let previousSummary: string | null = null;
  let compactionStartIndex = 1;
  
  // Detect if message[1] is a summary from previous compaction
  if (
    messages[1]?.role === 'assistant' &&
    typeof messages[1].content === 'string' &&
    messages[1].content.startsWith('## Session Summary')
  ) {
    previousSummary = messages[1].content;
    compactionStartIndex = 2; // Skip the existing summary
  }

  // If boundary is at or before compaction start, nothing to compact
  if (boundaryIndex <= compactionStartIndex) {
    return {
      messagesToCompact: [],
      messagesToKeep: messages,
      previousSummary,
    };
  }

  return {
    messagesToCompact: messages.slice(compactionStartIndex, boundaryIndex),
    messagesToKeep: [
      systemMessage,
      // Summary will be inserted here by compact()
      ...messages.slice(boundaryIndex),
    ],
    previousSummary,
  };
}
```

### Visual Example

```
Before Compaction (50 messages, keepLast=10):
┌─────────────────────────────────────────────────────────────────────────┐
│ [0]  system                                                    KEEP     │
│ [1]  user: "Build a flashcard app"                                      │
│ [2]  assistant: "I'll start by..." + tool_call                         │
│ [3]  tool: result                                                       │
│ [4]  assistant: "Now let's..." + tool_call                             │
│ [5]  tool: result                                                       │
│ ...                                                            COMPACT  │
│ [38] assistant: "Creating tests..."                                     │
│ [39] tool: result                                                       │
├─────────────────────────────────────────────────────────────────────────┤
│ [40] assistant: "Adding SM-2..." + tool_call                   KEEP     │
│ [41] tool: result                                                       │
│ [42] assistant: "Testing..." + tool_call                               │
│ [43] tool: result                                                       │
│ [44] assistant: "Fixing type error..." + tool_call                     │
│ [45] tool: result                                                       │
│ [46] assistant: "All tests pass"                                       │
│ [47] user: "Add AI integration"                                         │
│ [48] assistant: "I'll add OpenAI..." + tool_call                       │
│ [49] tool: result                                              KEEP     │
└─────────────────────────────────────────────────────────────────────────┘

After Compaction:
┌─────────────────────────────────────────────────────────────────────────┐
│ [0] system                                                              │
│ [1] assistant: "## Session Summary (Round 1)..."  ← NEW SUMMARY         │
│ [2] assistant: "Adding SM-2..." + tool_call       ← WAS [40]            │
│ [3] tool: result                                  ← WAS [41]            │
│ ...                                               (remaining 10)        │
│ [11] tool: result                                 ← WAS [49]            │
└─────────────────────────────────────────────────────────────────────────┘
```

### Tool Pair Preservation

```typescript
/**
 * Ensure we never orphan tool results from their tool calls.
 * A tool result without its calling message confuses the LLM.
 */
function adjustBoundaryForToolPairs(
  messages: CoreMessage[],
  initialBoundary: number
): number {
  let boundary = initialBoundary;
  
  // Walk backward while we're pointing at a tool message
  while (
    boundary > 1 && 
    messages[boundary] && 
    messages[boundary].role === 'tool'
  ) {
    boundary--;
  }
  
  return boundary;
}
```

---

## Summary Generation

### Function Signature

```typescript
async function generateSummary(
  messagesToCompact: CoreMessage[],
  previousSummary: string | null,
  originalTask: string,
  compactionRound: number,
  model: LanguageModel
): Promise<string>
```

### Implementation

```typescript
import { generateText, type LanguageModel, type CoreMessage } from 'ai';

/**
 * Generate a structured summary of compacted messages using LLM.
 * 
 * The summary preserves critical context needed to continue the task:
 * - Original user request (verbatim)
 * - Files created/modified with their purposes
 * - Technical decisions that affect future work
 * - Current progress and pending items
 * - Errors encountered and how they were resolved
 */
async function generateSummary(
  messagesToCompact: CoreMessage[],
  previousSummary: string | null,
  originalTask: string,
  compactionRound: number,
  model: LanguageModel
): Promise<string> {
  // Format messages for the summarization prompt
  const formattedMessages = formatMessagesForSummary(messagesToCompact);
  
  const systemPrompt = `You are summarizing a coding agent's conversation history.
Your summary will replace the compacted messages, so preserve ALL information 
needed to continue the task successfully.

CRITICAL: Be thorough but concise. Missing information cannot be recovered.`;

  const userPrompt = `## Previous Summary
${previousSummary ?? 'None - this is the first compaction round.'}

## Original User Task
${originalTask}

## Messages to Summarize
${formattedMessages}

## Instructions
Create a summary with these EXACT sections:

### Session Summary (Compaction Round ${compactionRound})

#### Original Task
[Preserve the user's original request verbatim]

#### Completed Work
| File/Component | Action | Description |
|----------------|--------|-------------|
[List each file touched with what was done]

#### Key Technical Decisions
- [Bullet list of choices that affect future work]
- [Include dependencies installed, patterns used, etc.]

#### Current State
- Working on: [what's in progress]
- Last completed: [most recent accomplishment]

#### Pending Work
- [ ] [Remaining items as checklist]

#### Errors & Resolutions
[Only include if errors were encountered. Format: error → resolution]

## Constraints
- Maximum 800 tokens
- Use tables and bullet points for density
- Include exact file paths
- No code blocks unless absolutely critical
- If previous summary exists, INTEGRATE (don't duplicate) its content`;

  const { text } = await generateText({
    model,
    system: systemPrompt,
    prompt: userPrompt,
    maxTokens: 1000, // Allow some buffer over 800 target
    temperature: 0.3, // Lower temperature for factual summary
  });

  return text;
}

/**
 * Format messages into a readable string for summarization.
 */
function formatMessagesForSummary(messages: CoreMessage[]): string {
  return messages.map((msg, idx) => {
    const role = msg.role.toUpperCase();
    let content = '';
    
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map(part => {
        if (part.type === 'text') return part.text;
        if (part.type === 'tool-call') return `[Tool: ${part.toolName}(${JSON.stringify(part.args)})]`;
        if (part.type === 'tool-result') return `[Result: ${JSON.stringify(part.result).slice(0, 500)}...]`;
        return '';
      }).join('\n');
    }
    
    // Truncate very long content
    if (content.length > 2000) {
      content = content.slice(0, 2000) + '\n[...truncated...]';
    }
    
    return `[${idx}] ${role}:\n${content}`;
  }).join('\n\n---\n\n');
}
```

### Summary Structure Template

```markdown
## Session Summary (Compaction Round {N})

### Original Task
{User's original request - preserved verbatim}

### Completed Work
| File/Component | Action | Description |
|----------------|--------|-------------|
| src/db.ts | Created | SQLite schema with flashcards, users tables |
| src/sm2.ts | Created | SM-2 spaced repetition algorithm |
| src/index.ts | Modified | Added CLI commands for review |
| package.json | Modified | Added drizzle-orm, bun-sqlite deps |

### Key Technical Decisions
- Using Drizzle ORM with bun:sqlite for type-safe persistence
- Implementing SM-2 algorithm with quality ratings 0-5
- Storing ease factor as float (default 2.5) for precision
- Using UUID for flashcard IDs

### Current State
- Working on: AI integration for flashcard generation
- Last completed: SM-2 algorithm with passing tests

### Pending Work
- [ ] OpenAI API integration for topic-based card generation
- [ ] Review session CLI command
- [ ] Final integration testing

### Errors & Resolutions
- TypeScript error in sm2.ts (missing types) → Added explicit type annotations
- bun install failed (network) → Retried successfully

{If previous summary exists: "This summary incorporates context from {N-1} previous compaction rounds."}
```

---

## Main Compaction Function

### Function Signature

```typescript
interface CompactionResult {
  compactedMessages: CoreMessage[];
  compactionEvent: {
    round: number;
    tokensBefore: number;
    tokensAfter: number;
    summaryContent: string;
    compactedMessageIds: string[];
  };
}

async function compact(
  messages: CoreMessage[],
  sessionId: string,
  model: LanguageModel,
  config?: CompactionConfig
): Promise<CompactionResult>
```

### Implementation

```typescript
import type { CoreMessage, LanguageModel } from 'ai';

/**
 * Perform context compaction on the message array.
 * 
 * This is the main entry point called from prepareStep when
 * shouldCompact() returns true.
 */
async function compact(
  messages: CoreMessage[],
  sessionId: string,
  model: LanguageModel,
  config: CompactionConfig = DEFAULT_CONFIG
): Promise<CompactionResult> {
  const tokensBefore = estimateMessagesTokens(messages);
  
  // 1. Select messages to compact vs keep
  const selection = selectMessagesToCompact(
    messages,
    config.recentMessagesToKeep
  );
  
  // If nothing to compact, return unchanged
  if (selection.messagesToCompact.length === 0) {
    return {
      compactedMessages: messages,
      compactionEvent: {
        round: 0,
        tokensBefore,
        tokensAfter: tokensBefore,
        summaryContent: '',
        compactedMessageIds: [],
      },
    };
  }
  
  // 2. Determine compaction round from database
  const lastEvent = await getLastCompactionEvent(sessionId);
  const round = (lastEvent?.round ?? 0) + 1;
  
  // 3. Extract original task from first user message
  const originalTask = extractOriginalTask(messages);
  
  // 4. Generate summary using LLM
  const summaryContent = await generateSummary(
    selection.messagesToCompact,
    selection.previousSummary,
    originalTask,
    round,
    model
  );
  
  // 5. Construct new message array with summary
  const summaryMessage: CoreMessage = {
    role: 'assistant',
    content: summaryContent,
  };
  
  const compactedMessages: CoreMessage[] = [
    selection.messagesToKeep[0], // System message
    summaryMessage,              // New summary
    ...selection.messagesToKeep.slice(1), // Recent messages
  ];
  
  const tokensAfter = estimateMessagesTokens(compactedMessages);
  
  // 6. Log compaction metrics
  console.log(
    `[Compaction] Round ${round}: ${tokensBefore} → ${tokensAfter} tokens ` +
    `(${selection.messagesToCompact.length} messages summarized)`
  );
  
  return {
    compactedMessages,
    compactionEvent: {
      round,
      tokensBefore,
      tokensAfter,
      summaryContent,
      compactedMessageIds: [], // Populated by caller with DB message IDs
    },
  };
}

/**
 * Extract the original user task from the first user message.
 */
function extractOriginalTask(messages: CoreMessage[]): string {
  for (const msg of messages) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      return msg.content;
    }
  }
  return 'Unknown task';
}
```

---

## Chained Summary Handling

When compaction occurs multiple times in a session:

```
Session Start
     │
     ▼
Messages [1..40] accumulate
     │
     ▼ (threshold reached)
Round 1: Summarize [1..40] → Summary₁
     │
     ▼
Messages [Summary₁, 41..80] accumulate
     │
     ▼ (threshold reached)
Round 2: Summarize [Summary₁, 41..80] → Summary₂
     │   (Summary₂ INCLUDES content from Summary₁)
     ▼
Messages [Summary₂, 81..120] accumulate
     │
     ▼ (threshold reached)
Round 3: Summarize [Summary₂, 81..120] → Summary₃
     │   (Summary₃ INCLUDES content from Summary₂)
     ▼
  Continue...
```

### Chaining Rules

1. **Previous summary detection**: Check if `messages[1]` starts with `## Session Summary`
2. **Integration, not duplication**: Prompt instructs LLM to merge previous summary content
3. **Round tracking**: Each summary includes its round number
4. **Cumulative context**: Later summaries contain compressed versions of all prior work

---

## Edge Cases

| Scenario | Detection | Handling |
|----------|-----------|----------|
| **Single huge tool result** | Content > 10,000 chars | Truncate in `formatMessagesForSummary` before summarizing |
| **All messages are recent** | `boundaryIndex <= compactionStartIndex` | Return messages unchanged (no-op) |
| **Summary generation fails** | LLM API error | Catch error, log warning, return messages unchanged |
| **Orphaned tool message** | `messages[boundaryIndex].role === 'tool'` | Extend keepLast to include the tool_call |
| **Empty conversation** | `messages.length <= 1` | Return messages unchanged |
| **Very short session** | `messages.length <= keepLast + 1` | Return false from `shouldCompact()` |

### Error Handling in Compaction

```typescript
async function safeCompact(
  messages: CoreMessage[],
  sessionId: string,
  model: LanguageModel,
  config?: CompactionConfig
): Promise<CoreMessage[]> {
  try {
    const result = await compact(messages, sessionId, model, config);
    
    // Persist compaction event to database
    await saveCompactionEvent(sessionId, result.compactionEvent);
    
    // Mark old messages as compacted
    await markMessagesCompacted(
      sessionId,
      result.compactionEvent.compactedMessageIds
    );
    
    return result.compactedMessages;
    
  } catch (error) {
    // Log but don't fail the agent loop
    console.error('[Compaction] Failed, continuing without compaction:', error);
    return messages;
  }
}
```

---

## Integration with Agent Loop

### prepareStep Hook Usage

```typescript
import { generateText, type LanguageModel, type CoreMessage } from 'ai';

async function runAgent(
  sessionId: string,
  task: string,
  containerId: string,
  model: LanguageModel
) {
  let messages: CoreMessage[] = await loadActiveMessages(sessionId);
  
  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    messages,
    tools: agentTools,
    maxSteps: 50,
    
    prepareStep: async ({ messages: stepMessages }) => {
      // Check if compaction needed
      if (shouldCompact(stepMessages)) {
        const compacted = await safeCompact(
          stepMessages,
          sessionId,
          model
        );
        return { messages: compacted };
      }
      // No compaction needed
      return { messages: stepMessages };
    },
    
    onStepFinish: async ({ response }) => {
      // Persist new messages (handled by persistence layer)
      await persistStepMessages(sessionId, response.messages);
    },
  });
  
  return result;
}
```

---

## Testing Scenarios

### Unit Tests

1. **Token estimation accuracy**
   - Test with known text lengths
   - Verify conservative over-counting

2. **Boundary calculation**
   - Test tool pair preservation
   - Test with various message counts

3. **Summary generation**
   - Mock LLM response
   - Verify structure of generated summary

### Integration Tests

1. **Full compaction cycle**
   - Create session with many messages
   - Trigger compaction
   - Verify message count reduced
   - Verify summary content

2. **Chained compaction**
   - Run multiple compaction rounds
   - Verify previous summary integration

3. **Error recovery**
   - Simulate LLM failure
   - Verify graceful degradation

---

## Performance Considerations

| Aspect | Approach |
|--------|----------|
| **Token counting** | O(n) where n = total message length; cached per step |
| **LLM summary call** | Single call per compaction; ~500-1000 tokens output |
| **Memory** | Messages array replaced in-place; no duplication |
| **Database writes** | Batched in transaction |

---

## Files to Create

This layer will be implemented in `index.ts` within **SECTION 4: TOKEN ESTIMATION** and **SECTION 6: CONTEXT COMPACTION**.

### Exports (for internal use)

```typescript
// Token Estimation
export { estimateTokens, estimateMessagesTokens };

// Compaction Control
export { shouldCompact, selectMessagesToCompact };

// Main Functions  
export { compact, safeCompact, generateSummary };

// Types
export type { CompactionConfig, CompactionResult, CompactionSelection };
```
