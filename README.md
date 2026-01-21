# Context-Compacting Coding Agent

Build a coding agent that automatically compacts conversation history when approaching the model's context window limit.

## Problem

LLMs have finite context windows. Long-running agents that execute many tool calls will eventually exceed this limit and fail. Your task is to implement automatic context compaction that summarizes old messages while preserving enough information to continue the task.

## Requirements

### 1. Coding Agent

Build an agent using Vercel AI SDK that can:

- Execute shell commands inside a Docker container (sandboxed)
- Read and write files within the container
- List directory contents
- Respond to user coding tasks

Use the `ToolLoopAgent` class from the `ai` package (or `generateText` with `maxSteps`/`prepareStep` if you prefer lower-level control).

### 2. Context Compaction

Implement automatic compaction that:

- **Tracks token usage** - Estimate tokens for each message (simple heuristic is fine)
- **Triggers compaction** - When approaching ~80% of the model's context limit
- **Summarizes history** - Use the LLM to create a concise summary of old messages
- **Preserves recent context** - Keep the last N messages intact (uncompacted)
- **Chains summaries** - If you compact multiple times, include previous summary in new summary

### 3. Persistence with Drizzle + SQLite

Use Drizzle ORM with `bun:sqlite` to persist:

- Sessions
- Messages (with token counts)
- Compaction events (summary, which messages were compacted)

Design the schema yourself.

### 4. Docker Sandboxing

All shell commands must run inside a Docker container for safety. The agent should:

- Start/manage a container for the session
- Execute commands inside it
- Clean up when done

## Test Task

Once your agent is working, test it by giving it this prompt:

> Build a flashcard app like Anki with AI integration. It should:
> - Store flashcards with front/back content in SQLite
> - Use spaced repetition (SM-2 algorithm or similar)
> - Include an AI feature that generates flashcards from a topic
> - Be written in TypeScript with Bun

This task is complex enough to require many tool calls and will test your context compaction. The agent should be able to complete it in a single session without running out of context.

## Getting Started

```bash
bun install
bun run index.ts
```

## What We're Looking For

1. **Working compaction** - Agent can handle long tasks without context overflow
2. **Clean code** - Readable, well-structured, minimal abstractions
3. **Correct persistence** - Messages and compactions are properly stored
4. **Edge cases** - Handles errors, empty states gracefully

## Constraints

- Single `index.ts` file (schema types can be inline)
- Use `bun:sqlite` with Drizzle (not better-sqlite3)
- Use Vercel AI SDK (`ai` package)
- Docker required for command execution
- Choose any LLM provider (OpenAI, Anthropic, etc.)

## Hints

- `prepareStep` in `generateText` lets you modify messages between steps
- Consider what information is essential vs. what can be safely summarized
- The summary prompt matters - be specific about what to preserve

## Time

2-4 hours expected.
