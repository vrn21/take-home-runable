# Context-Compacting Coding Agent: Design Document

## Table of Contents

1. [Overview](#overview)
2. [Constraints](#constraints)
3. [Architecture](#architecture)
4. [File Structure](#file-structure)
5. [Context Compaction System](#context-compaction-system)
6. [Docker Sandbox System](#docker-sandbox-system)
7. [Persistence Layer](#persistence-layer)
8. [Agent Loop](#agent-loop)
9. [Error Handling](#error-handling)
10. [Configuration & Constants](#configuration--constants)
11. [Industry Standards & References](#industry-standards--references)

---

## Overview

### Problem Statement

LLMs have finite context windows. Long-running coding agents that execute many tool calls accumulate messages—user prompts, tool invocations, tool results, and assistant responses—eventually exceeding context limits and failing mid-task.

### Solution

An intelligent context compaction system that:
- Monitors token usage using simple heuristic estimation
- Triggers compaction before overflow occurs
- Summarizes historical context while preserving critical information
- Chains summaries across multiple compaction events
- Persists state for debugging

### Design Principles

| Principle | Rationale |
|-----------|-----------|
| **Simplicity** | Single-file implementation; minimal abstractions; heuristic over exact |
| **Robustness** | Conservative thresholds, graceful degradation on errors |
| **Isolation** | All code execution sandboxed in Docker containers |

---

## Constraints

### Hard Constraints (from requirements)

| Constraint | Implication |
|------------|-------------|
| **Single `index.ts` file** | All code in one file; use logical sections with clear comments |
| **Schema types inline** | Drizzle schema defined within index.ts |
| **`bun:sqlite` with Drizzle** | Not better-sqlite3; use Drizzle's Bun SQLite driver |
| **Vercel AI SDK (`ai` package)** | Use `generateText` with `prepareStep` or `ToolLoopAgent` |
| **Docker for command execution** | All shell commands run inside container |

### MVP Scope

This design targets an MVP that:
- Is fully functional for **single-session usage only**
- Can complete the test task (building a flashcard app) without context overflow
- Persists sessions, messages, and compaction events correctly
- Handles errors gracefully

**Explicitly out of scope**: Multi-session management, session resume, horizontal scaling.

---

## Architecture

### High-Level System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                Entry Point                                  │
│                              (CLI Interface)                                │
│                                                                             │
│  • Prompt user for task via stdin                                           │
│  • Initialize database                                                      │
│  • Orchestrate session lifecycle                                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             Session Lifecycle                               │
│                                                                             │
│  • Create session record                                                    │
│  • Start Docker container                                                   │
│  • Run agent loop                                                           │
│  • Update status & cleanup                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
┌───────────────────────┐  ┌───────────────────┐  ┌───────────────────────┐
│     Agent Loop        │  │     Docker        │  │   Persistence         │
│                       │  │                   │  │   Layer               │
│  • Vercel AI SDK      │  │  • Start/stop     │  │                       │
│  • Tool orchestration │  │  • Execute cmds   │  │  • Sessions           │
│  • prepareStep hook   │  │                   │  │  • Messages           │
│  • onStepFinish hook  │  │                   │  │  • Compaction events  │
└───────────────────────┘  └───────────────────┘  └───────────────────────┘
          │                         │                       │
          ▼                         │                       │
┌───────────────────────┐           │                       │
│  Context Compactor    │           │                       │
│                       │           │                       │
│  • Token counting     │           │                       │
│  • Threshold check    │           │                       │
│  • LLM summarization  │           │                       │
│  • Summary chaining   │           │                       │
└───────────────────────┘           │                       │
          │                         │                       │
          ▼                         ▼                       ▼
┌───────────────────────┐  ┌───────────────────┐  ┌───────────────────────┐
│   Token Estimator     │  │   Docker Engine   │  │   SQLite + Drizzle    │
│   (Heuristic)         │  │                   │  │   (bun:sqlite)        │
└───────────────────────┘  └───────────────────┘  └───────────────────────┘
```

### Request Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            User Request                                  │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │  1. Create Session  │
                         │     in Database     │
                         └─────────────────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │  2. Start Docker    │
                         │     Container       │
                         └─────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          3. Agent Loop                                   │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                                                                    │  │
│  │   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐        │  │
│  │   │ prepareStep  │───▶│ Check Token  │───▶│  Compact if  │        │  │
│  │   │              │    │    Count     │    │  Threshold   │        │  │
│  │   └──────────────┘    └──────────────┘    └──────────────┘        │  │
│  │          │                                        │               │  │
│  │          ▼                                        ▼               │  │
│  │   ┌──────────────┐                        ┌──────────────┐        │  │
│  │   │   LLM Call   │◀───────────────────────│   Messages   │        │  │
│  │   │              │                        │  (compacted) │        │  │
│  │   └──────────────┘                        └──────────────┘        │  │
│  │          │                                                        │  │
│  │          ▼                                                        │  │
│  │   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐        │  │
│  │   │ Tool Calls?  │───▶│   Execute    │───▶│   Append     │        │  │
│  │   │              │yes │  in Docker   │    │   Results    │        │  │
│  │   └──────────────┘    └──────────────┘    └──────────────┘        │  │
│  │          │ no                                     │               │  │
│  │          ▼                                        ▼               │  │
│  │   ┌──────────────┐                        ┌──────────────┐        │  │
│  │   │  Persist to  │◀───────────────────────│ onStepFinish │        │  │
│  │   │   Database   │                        │              │        │  │
│  │   └──────────────┘                        └──────────────┘        │  │
│  │          │                                                        │  │
│  │          ▼                                                        │  │
│  │   ┌──────────────┐                                                │  │
│  │   │ Continue or  │──────────────────────────────────▶ Loop        │  │
│  │   │    Stop?     │                                                │  │
│  │   └──────────────┘                                                │  │
│  │                                                                    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │  4. Update Session  │
                         │     Status          │
                         └─────────────────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │  5. Cleanup Docker  │
                         │     Container       │
                         └─────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                             Response                                     │
└──────────────────────────────────────────────────────────────────────────┘
```

### Component Interaction Matrix

| Component | Depends On | Depended By |
|-----------|------------|-------------|
| Entry Point (main) | All sections | - |
| Session Lifecycle | Agent Loop, Docker, Persistence | Entry Point |
| Agent Loop | Context Compactor, Tools, Persistence | Session Lifecycle |
| Context Compactor | Token Estimator, LLM Provider | Agent Loop |
| Token Estimator | - (pure function) | Context Compactor |
| Docker Functions | Docker Engine | Session Lifecycle, Tools |
| Persistence Layer | SQLite, Drizzle | All components |
| Tools | Docker Functions | Agent Loop |

---

## File Structure

Since all code resides in a single `index.ts`, we organize it into **logical sections** with clear comment headers:

```
index.ts
│
├── // ============================================================
├── // SECTION 1: IMPORTS & TYPES
├── // ============================================================
│   • External dependencies (ai, drizzle, zod, etc.)
│   • Type definitions for Session, Message, CompactionEvent
│   • Tool parameter types
│
├── // ============================================================
├── // SECTION 2: CONFIGURATION & CONSTANTS
├── // ============================================================
│   • Model context limit (configurable per provider)
│   • Token thresholds
│   • Docker settings
│
├── // ============================================================
├── // SECTION 3: DATABASE SCHEMA (Drizzle)
├── // ============================================================
│   • sessions table
│   • messages table (with is_compacted flag)
│   • compaction_events table
│   • Database initialization
│
├── // ============================================================
├── // SECTION 4: TOKEN ESTIMATION
├── // ============================================================
│   • estimateTokens(text) - heuristic function
│   • estimateMessagesTokens(messages) function
│
├── // ============================================================
├── // SECTION 5: DOCKER FUNCTIONS
├── // ============================================================
│   • startContainer(sessionId) function
│   • execInContainer(containerId, command) function
│   • cleanupContainer(containerId) function
│
├── // ============================================================
├── // SECTION 6: CONTEXT COMPACTION
├── // ============================================================
│   • shouldCompact(messages) function
│   • selectMessagesToCompact(messages) function
│   • generateSummary(messages, previousSummary) function
│   • compact(messages, sessionId) function
│
├── // ============================================================
├── // SECTION 7: TOOLS
├── // ============================================================
│   • execute_command tool
│   • read_file tool
│   • write_file tool
│   • list_directory tool
│
├── // ============================================================
├── // SECTION 8: AGENT LOOP
├── // ============================================================
│   • runAgent(sessionId, task, containerId) function
│   • prepareStep callback
│   • onStepFinish callback
│
├── // ============================================================
├── // SECTION 9: SESSION LIFECYCLE
├── // ============================================================
│   • createSession(task) function
│   • updateSessionStatus(id, status) function
│   • runSession(task) - main orchestration function
│
└── // ============================================================
    // SECTION 10: MAIN ENTRY POINT
    // ============================================================
    • Prompt for task via stdin (e.g., "> build a flashcard app")
    • Run session with user's input
    • Handle errors and exit
```

**CLI Usage**:
```
$ bun run index.ts
> Build a flashcard app like Anki with AI integration...
```

The agent reads the task from stdin, allowing multi-line input if needed.

### Section Dependencies

```
┌───────────────────────────────────────────────────────────────────────┐
│                     Section Dependency Graph                          │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│   [1] Imports & Types                                                 │
│         │                                                             │
│         ▼                                                             │
│   [2] Configuration ──────────────────────────────────────────────┐   │
│         │                                                         │   │
│         ▼                                                         │   │
│   [3] Database Schema                                             │   │
│         │                                                         │   │
│         ├────────────────────┬────────────────────┐               │   │
│         ▼                    ▼                    ▼               │   │
│   [4] Token Counting   [5] Docker            [6] Compaction ◀─────┤   │
│         │                    │                    │               │   │
│         │                    ▼                    │               │   │
│         │              [7] Tools ◀────────────────┤               │   │
│         │                    │                    │               │   │
│         ▼                    ▼                    ▼               │   │
│         └────────────▶ [8] Agent Loop ◀───────────┘               │   │
│                              │                                    │   │
│                              ▼                                    │   │
│                        [9] Session Lifecycle ◀────────────────────┘   │
│                              │                                        │
│                              ▼                                        │
│                        [10] Main Entry Point                          │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

---

## Context Compaction System

### Token Estimation Strategy

**Approach**: Simple heuristic (as permitted by requirements)

| Method | Formula | Accuracy |
|--------|---------|----------|
| Character-based | `Math.ceil(text.length / 4)` | ~75-80% |

**Why Heuristic**:
- Requirements explicitly allow "simple heuristic is fine"
- No external dependencies
- Works across all LLM providers
- Conservative estimate (slightly over-counts) prevents overflow

**Token Budget Allocation**:

The context limit is **configurable based on the chosen model**:

| Model | Context Limit |
|-------|---------------|
| GPT-4o | 128,000 |
| GPT-4-turbo | 128,000 |
| Claude 3.5 Sonnet | 200,000 |
| Claude 3 Haiku | 200,000 |

**Budget Calculation** (using GPT-4o as example):

```
MODEL_CONTEXT_LIMIT   = 128,000 (configurable)
SYSTEM_RESERVE        = 2,000   (system prompt + tool definitions)
OUTPUT_RESERVE        = 4,000   (space for model response)
SAFETY_BUFFER         = 5,000   (heuristic variance buffer)

AVAILABLE_FOR_MESSAGES = 128,000 - 2,000 - 4,000 - 5,000 = 117,000
COMPACTION_THRESHOLD   = 117,000 × 0.80 = ~93,600 tokens
```

The threshold triggers compaction at **80% of available space**, leaving headroom for the next response.

### Compaction Trigger Logic

**Trigger Point**: Inside `prepareStep` callback, evaluated before each LLM call

**Decision Flow**:

```
                    ┌─────────────────────┐
                    │   prepareStep       │
                    │   called            │
                    └─────────────────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │ Count total tokens  │
                    │ in message array    │
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
              ┌──────────────┐  ┌──────────────┐
              │   Trigger    │  │   Return     │
              │  compaction  │  │  unchanged   │
              └──────────────┘  └──────────────┘
```

**Protected Messages** (never compacted):
- System message (index 0)
- Last N messages (configurable, default 10)
- Incomplete tool call/result pairs

### Message Selection for Compaction

**The Problem**: Tool calls and results must stay together. Orphaned tool_call or tool_result messages break the LLM's understanding.

**Selection Algorithm**:

```
Input: messages[], keepLast = 10

1. Always keep: messages[0] (system message)

2. Determine recent boundary:
   - Start with lastIndex = messages.length - keepLast
   
3. Adjust for tool pairs:
   - While messages[lastIndex].role === "tool":
       lastIndex -= 1  // Include the tool_call that produced this result
   
4. Messages to compact: messages[1..lastIndex-1]
   Messages to keep:    messages[0] + messages[lastIndex..]

5. If nothing to compact (lastIndex <= 1):
   Return messages unchanged (no-op)
```

**Visual Example**:

```
Before Compaction:
┌─────────────────────────────────────────────────────────────────────────┐
│ [0] system                                                              │
│ [1] user: "Build a flashcard app"                                       │
│ [2] assistant: "I'll start by..." + tool_call(write_file)               │
│ [3] tool: result of write_file                                          │
│ [4] assistant: "Now let's..." + tool_call(execute_command)              │
│ [5] tool: result of execute_command                                     │
│ ... (many more messages)                                                │
│ [45] assistant: "Adding SM-2..." + tool_call(write_file)                │
│ [46] tool: result of write_file                                         │
│ [47] assistant: "Testing..." + tool_call(execute_command)               │
│ [48] tool: result                                                       │
│ [49] assistant: "All tests pass"                                        │
└─────────────────────────────────────────────────────────────────────────┘

After Compaction (keepLast=10):
┌─────────────────────────────────────────────────────────────────────────┐
│ [0] system                                                              │
│ [1] assistant: "## Session Summary..."              ← NEW SUMMARY       │
│ [2] assistant: "Adding SM-2..." + tool_call        ← WAS [45]           │
│ [3] tool: result                                   ← WAS [46]           │
│ [4] assistant: "Testing..."                        ← WAS [47]           │
│ [5] tool: result                                   ← WAS [48]           │
│ [6] assistant: "All tests pass"                    ← WAS [49]           │
└─────────────────────────────────────────────────────────────────────────┘
```

### Summary Content Structure

The summary is inserted as an **assistant message** after the system message:

```
## Session Summary (Compaction Round {N})

### Original Task
{User's original request - preserved verbatim}

### Completed Work
| File | Action | Description |
|------|--------|-------------|
| src/db.ts | Created | SQLite schema with flashcards table |
| src/sm2.ts | Created | SM-2 spaced repetition algorithm |
| src/index.ts | Modified | Added CLI interface |

### Key Technical Decisions
- Using Drizzle ORM with bun:sqlite for persistence
- Implementing SM-2 algorithm with 6 quality ratings (0-5)
- Storing flashcard ease factor as float for precision

### Current State
Working on: AI integration for flashcard generation
Last completed: SM-2 algorithm implementation with tests

### Pending Work
- [ ] OpenAI integration for topic-based card generation
- [ ] Review session CLI command
- [ ] Final integration testing

### Errors Encountered & Resolutions
- TypeScript error in sm2.ts: Fixed by adding type annotations

{If previous summary: "This summary incorporates context from {N-1} previous rounds."}
```

**Token Budget for Summary**: Target 500-1000 tokens. The summarization prompt instructs conciseness.

### Summarization Prompt

```
You are summarizing a coding agent's conversation history. Your summary 
will replace the compacted messages, so preserve all information needed 
to continue the task.

PREVIOUS SUMMARY (if any):
{previous_summary or "None - this is the first compaction"}

MESSAGES TO SUMMARIZE:
{formatted messages}

ORIGINAL USER TASK:
{extracted from first user message}

Create a summary with these sections:
1. Original Task - preserve the user's request verbatim
2. Completed Work - table of files with actions and purposes
3. Key Technical Decisions - choices that affect future work
4. Current State - what's being worked on now
5. Pending Work - remaining items as checklist
6. Errors & Resolutions - issues and how they were fixed

CONSTRAINTS:
- Maximum 800 tokens
- Use bullet points and tables
- Include exact file paths
- No code blocks unless critical
- If previous summary exists, integrate (don't duplicate)
```

### Chained Summary Handling

When compaction occurs multiple times:

```
Round 1: Summarize messages [1..40] → Summary₁
Round 2: Summarize [Summary₁, messages 41..80] → Summary₂  
Round 3: Summarize [Summary₂, messages 81..120] → Summary₃
```

**Chaining Rules**:
1. Previous summary is included in context for new summarization
2. LLM is instructed to integrate, not duplicate, previous content
3. Each summary includes its round number for tracking

### Edge Cases

| Scenario | Handling |
|----------|----------|
| Single huge tool result | Truncate to MAX_OUTPUT_LENGTH (10,000 chars) before storing |
| All messages are recent | No-op - nothing old enough to compact |
| Summary generation fails | Log warning, skip compaction, continue agent loop |
| Orphaned tool message | Extend keepLast to include the associated tool_call |
| Empty conversation | No-op - nothing to compact |

---

## Docker Sandbox System

### Container Lifecycle

Simple lifecycle: start at session begin, cleanup at session end.

```
Session Start
     │
     ▼
┌─────────────────────────────────────────────────┐
│              CREATE CONTAINER                   │
│                                                 │
│  docker run -d --name coding-agent-{session_id} │
│    -w /workspace                                │
│    oven/bun:latest                              │
│    tail -f /dev/null                            │
└─────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────┐
│              EXECUTION PHASE                    │
│                                                 │
│  Commands executed via: docker exec             │
│  Files read/written via: docker exec            │
└─────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────┐
│              CLEANUP (in finally)               │
│                                                 │
│  docker stop {container}                        │
│  docker rm {container}                          │
└─────────────────────────────────────────────────┘
```

### Container Configuration

| Setting | Value | Rationale |
|---------|-------|-----------|
| **Image** | `oven/bun:latest` | Official Bun image with Node.js compatibility |
| **Name** | `coding-agent-{session_id}` | Unique per session |
| **Working Directory** | `/workspace` | Clean, isolated workspace |
| **Keep-Alive Command** | `tail -f /dev/null` | Keeps container running for exec commands |
| **Network** | Default bridge (enabled) | Required for `bun install`, API calls |

### Command Execution

All tools use `docker exec` to run inside the container:

| Tool | Docker Command |
|------|----------------|
| `execute_command` | `docker exec {container} sh -c "{cmd}"` |
| `read_file` | `docker exec {container} cat "/workspace/{path}"` |
| `write_file` | `docker exec {container} sh -c "mkdir -p \"$(dirname /workspace/{path})\" && cat > /workspace/{path}"` (with content piped via stdin) |
| `list_directory` | `docker exec {container} ls -la "/workspace/{path}"` |

**Result Structure**:

| Field | Type | Description |
|-------|------|-------------|
| stdout | string | Standard output |
| stderr | string | Standard error |
| exitCode | number | 0 = success |

### Path Handling

- All paths are relative to `/workspace`
- Paths are prefixed with `/workspace/` before execution
- No path validation for escaping (keeping it simple for MVP)

---

## Persistence Layer

### Technology Stack

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Database | SQLite | Simple, file-based, no setup required |
| Driver | `bun:sqlite` | Bun's native SQLite, fast, built-in |
| ORM | Drizzle | Type-safe, lightweight, good DX |
| File | `agent.db` | Single file in project root |

### Schema Design

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              SESSIONS                                   │
├─────────────────────────────────────────────────────────────────────────┤
│  id              TEXT PRIMARY KEY    UUID, unique identifier            │
│  created_at      INTEGER             Unix timestamp (ms)                │
│  status          TEXT                "active" | "completed" | "failed"  │
│  task            TEXT                Original user task/prompt          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ 1:N
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                              MESSAGES                                   │
├─────────────────────────────────────────────────────────────────────────┤
│  id              TEXT PRIMARY KEY    UUID, unique identifier            │
│  session_id      TEXT NOT NULL       FK → sessions.id                   │
│  sequence        INTEGER NOT NULL    Order within session (1, 2, 3...)  │
│  role            TEXT NOT NULL       "system"|"user"|"assistant"|"tool" │
│  content         TEXT NOT NULL       Message content (same format all types) │
│  token_count     INTEGER NOT NULL    Estimated token count (heuristic)  │
│  is_compacted    INTEGER DEFAULT 0   0 = active, 1 = compacted          │
│  created_at      INTEGER             Unix timestamp (ms)                │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ N:1
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          COMPACTION_EVENTS                              │
├─────────────────────────────────────────────────────────────────────────┤
│  id              TEXT PRIMARY KEY    UUID, unique identifier            │
│  session_id      TEXT NOT NULL       FK → sessions.id                   │
│  round           INTEGER NOT NULL    Compaction sequence (1, 2, 3...)   │
│  created_at      INTEGER             Unix timestamp (ms)                │
│  tokens_before   INTEGER             Total tokens before compaction     │
│  tokens_after    INTEGER             Total tokens after compaction      │
│  summary_content TEXT                The generated summary              │
└─────────────────────────────────────────────────────────────────────────┘
```

**Compaction Behavior**:
- When compaction occurs, old messages are marked `is_compacted = 1`
- A new summary message is inserted with `role = "assistant"`
- The compaction_events table records metrics and the summary

### Key Operations

| Operation | Description |
|-----------|-------------|
| Create session | Insert new session with status "active" |
| Get active messages | Select messages where `is_compacted = 0`, ordered by sequence |
| Save message | Insert with next sequence number, estimate token count |
| Mark compacted | Update `is_compacted = 1` for messages before sequence N |
| Insert summary | Insert new message with `role = "assistant"` containing summary |
| Record compaction | Insert compaction_event with before/after token metrics |
| Get latest compaction | Select where session_id, order by round DESC, limit 1 |
| Update session status | Update status to "completed" or "failed" |

### Transaction Safety

Compaction involves multiple writes that must be atomic:
1. Insert compaction_events record
2. Mark old messages as compacted
3. Insert summary message

**Solution**: Wrap all three operations in `db.transaction()` for atomicity.

### Message Persistence

Messages are persisted **after each agent step** via `onStepFinish`:
1. Extract new messages from step result
2. Calculate token count for each
3. Insert with next sequence number
4. Update timestamps

---

## Agent Loop

### Message Initialization

Before starting the agent loop, two initial messages are seeded:

| Sequence | Role | Source | Description |
|----------|------|--------|-------------|
| 1 | `system` | **Programmer-provided** | Hardcoded in `index.ts` (see System Prompt below) |
| 2 | `user` | **Stdin input** | User's task read from stdin prompt |

Both are persisted to the database before the first `generateText` call.

### Vercel AI SDK Integration

Use `generateText` with `maxSteps` and `prepareStep`:

**Key Configuration**:

| Option | Purpose |
|--------|---------|
| model | LLM provider (Anthropic/OpenAI) |
| system | System prompt defining agent behavior |
| tools | Four tools: execute_command, read_file, write_file, list_directory |
| maxSteps | Limit iterations (default 50) |
| prepareStep | Hook for compaction - intercept messages before each LLM call |
| onStepFinish | Hook for persistence - save messages after each step |

### prepareStep Hook

**Purpose**: Intercept and potentially modify messages before each LLM call

**Responsibilities**:
1. Estimate total tokens in message array using heuristic
2. Check against compaction threshold
3. If threshold exceeded, trigger compaction
4. Return modified messages (or unchanged)

### onStepFinish Hook

**Purpose**: Persist messages after each step completes

**Responsibilities**:
1. Extract new messages from step result
2. Calculate token counts
3. Persist to database with sequence numbers

### Tool Definitions

Each tool is defined using Vercel AI SDK's `tool` helper:

| Tool | Parameters | Description |
|------|------------|-------------|
| `execute_command` | `{ command: string }` | Execute shell command in container |
| `read_file` | `{ path: string }` | Read file contents |
| `write_file` | `{ path: string, content: string }` | Write/create file |
| `list_directory` | `{ path: string }` | List directory contents |

### System Prompt

```
You are a coding agent that builds software by executing commands and managing files.

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
- Minimal comments (code should be self-documenting)
- Follow language/framework conventions
- Test your work before declaring completion

CONSTRAINTS:
- Do not ask clarifying questions - make reasonable assumptions
- Focus on implementation, minimize explanation
```

### Stop Conditions

The agent loop stops when:
1. **Max steps reached** (50 by default)
2. **No tool calls** - LLM returns text-only response (task complete)
3. **Explicit completion** - LLM indicates task is done
4. **Fatal error** - Unrecoverable error during execution

---

## Error Handling

### Error Strategy

**Principle**: Fail fast for fatal errors, let LLM handle tool errors

| Error Type | Handling |
|------------|----------|
| Container start fails | Fail session, log error |
| Container exec fails | Return error to LLM as tool result |
| LLM API error | Fail session, log error |
| Compaction fails | Log warning, skip compaction, continue |
| Database write fails | Fail session |
| Command timeout/error | Return stdout/stderr to LLM (it decides) |

### Cleanup Guarantee

Container must be cleaned up regardless of outcome:

```
try {
    session = createSession(task)
    containerId = startContainer(session.id)
    result = runAgent(session.id, task, containerId)
    updateSessionStatus(session.id, "completed")
    return result
    
} catch (error) {
    updateSessionStatus(session.id, "failed")
    throw error
    
} finally {
    // ALWAYS executes
    cleanupContainer(containerId)
}
```

### Logging

Simple console logging:
- Session start/end
- Compaction triggered (with before/after token counts)
- Errors encountered

---

## Configuration & Constants

### Token Configuration

| Constant | Default | Description |
|----------|---------|-------------|
| `MODEL_CONTEXT_LIMIT` | 128000 | **Configurable per model** (see table below) |
| `SYSTEM_RESERVE` | 2000 | Reserved for system prompt + tools |
| `OUTPUT_RESERVE` | 4000 | Reserved for model response |
| `SAFETY_BUFFER` | 5000 | Heuristic variance buffer |
| `COMPACTION_THRESHOLD_PERCENT` | 0.80 | Trigger at 80% of available |
| `RECENT_MESSAGES_TO_KEEP` | 10 | Messages preserved during compaction |

**Model Context Limits**:

| Model | Context Limit |
|-------|---------------|
| GPT-4o | 128,000 |
| GPT-4-turbo | 128,000 |
| Claude 3.5 Sonnet | 200,000 |

### Container Configuration

| Constant | Default | Description |
|----------|---------|-------------|
| `DOCKER_IMAGE` | `oven/bun:latest` | Base image for containers |
| `CONTAINER_PREFIX` | `coding-agent-` | Container name prefix |
| `COMMAND_TIMEOUT_MS` | 60000 | Default command timeout |

### Agent Configuration

| Constant | Default | Description |
|----------|---------|-------------|
| `MAX_STEPS` | 50 | Maximum agent steps |
| `DB_PATH` | `./agent.db` | SQLite database file |

---

## Industry Standards & References

### Production Systems Analyzed

| System | Key Innovation | What We Adopted |
|--------|----------------|-----------------|
| **OpenHands** | Pluggable condenser system | Summary format, structured sections |
| **Aider** | Hierarchical summarization | Summary chaining across rounds |
| **Continue** | Token budget with smart pruning | Reserve allocation, tool pair preservation |

### Key Patterns Adopted

**1. LLM-Based Summarization** (from OpenHands)
- Use the same LLM to generate summaries
- Structured summary format for consistency
- Include metadata about compaction round

**2. Tool Pair Preservation** (from Continue)
- Never orphan tool_call or tool_result messages
- Extend keepLast boundary to include pairs
- Prevents LLM confusion about tool states

**3. Token Budget Allocation** (from Continue)
- Reserve space for system, output, safety
- Trigger compaction at 80% for headroom

### References

- **OpenHands**: `github.com/OpenHands/OpenHands` (condenser system)
- **Aider**: `github.com/Aider-AI/aider` (history.py)
- **Continue**: `github.com/continuedev/continue` (countTokens.ts)
- **Vercel AI SDK**: `github.com/vercel/ai`
