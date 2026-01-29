# Persistence Layer - Internal Design

## Overview

The Persistence Layer handles all database operations using Drizzle ORM with bun:sqlite. It stores sessions, messages, and compaction events for debugging and session continuity.

## Technology Stack

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Database | SQLite | Simple, file-based, no setup |
| Driver | `bun:sqlite` | Bun's native SQLite |
| ORM | Drizzle | Type-safe, lightweight |
| File | `agent.db` | Project root |

---

## Schema Definition

```typescript
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Database } from 'bun:sqlite';

// Sessions table
const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  status: text('status').notNull().$type<'active' | 'completed' | 'failed'>(),
  task: text('task').notNull(),
});

// Messages table
const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  sequence: integer('sequence').notNull(),
  role: text('role').notNull().$type<'system' | 'user' | 'assistant' | 'tool'>(),
  content: text('content').notNull(),
  tokenCount: integer('token_count').notNull(),
  isCompacted: integer('is_compacted').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

// Compaction events table
const compactionEvents = sqliteTable('compaction_events', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  round: integer('round').notNull(),
  createdAt: integer('created_at').notNull(),
  tokensBefore: integer('tokens_before').notNull(),
  tokensAfter: integer('tokens_after').notNull(),
  summaryContent: text('summary_content').notNull(),
});

type Session = typeof sessions.$inferSelect;
type Message = typeof messages.$inferSelect;
type CompactionEvent = typeof compactionEvents.$inferSelect;
```

---

## Database Initialization

```typescript
const DB_PATH = './agent.db';

function initDatabase() {
  const sqlite = new Database(DB_PATH);
  const db = drizzle(sqlite);
  
  // Create tables if not exist
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      task TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      sequence INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      is_compacted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS compaction_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      round INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      tokens_before INTEGER NOT NULL,
      tokens_after INTEGER NOT NULL,
      summary_content TEXT NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_compacted ON messages(session_id, is_compacted);
  `);
  
  return db;
}

const db = initDatabase();
```

---

## Session Operations

```typescript
import { eq } from 'drizzle-orm';

async function createSession(task: string): Promise<Session> {
  const id = crypto.randomUUID();
  const now = Date.now();
  
  await db.insert(sessions).values({
    id,
    createdAt: now,
    status: 'active',
    task,
  });
  
  return { id, createdAt: now, status: 'active', task };
}

async function updateSessionStatus(
  sessionId: string,
  status: 'active' | 'completed' | 'failed'
): Promise<void> {
  await db.update(sessions)
    .set({ status })
    .where(eq(sessions.id, sessionId));
}

async function getSession(sessionId: string): Promise<Session | null> {
  const result = await db.select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return result[0] ?? null;
}
```

---

## Message Operations

```typescript
import { and, eq, asc, desc, lt } from 'drizzle-orm';

async function saveMessage(
  sessionId: string,
  role: string,
  content: string,
  tokenCount: number
): Promise<Message> {
  const id = crypto.randomUUID();
  const now = Date.now();
  
  // Get next sequence number
  const lastMsg = await db.select({ seq: messages.sequence })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(desc(messages.sequence))
    .limit(1);
  
  const sequence = (lastMsg[0]?.seq ?? 0) + 1;
  
  await db.insert(messages).values({
    id,
    sessionId,
    sequence,
    role: role as 'system' | 'user' | 'assistant' | 'tool',
    content,
    tokenCount,
    isCompacted: 0,
    createdAt: now,
  });
  
  return { id, sessionId, sequence, role, content, tokenCount, isCompacted: 0, createdAt: now };
}

async function getActiveMessages(sessionId: string): Promise<Message[]> {
  return db.select()
    .from(messages)
    .where(and(
      eq(messages.sessionId, sessionId),
      eq(messages.isCompacted, 0)
    ))
    .orderBy(asc(messages.sequence));
}

async function markMessagesCompacted(
  sessionId: string,
  beforeSequence: number
): Promise<void> {
  await db.update(messages)
    .set({ isCompacted: 1 })
    .where(and(
      eq(messages.sessionId, sessionId),
      lt(messages.sequence, beforeSequence),
      eq(messages.isCompacted, 0)
    ));
}
```

---

## Compaction Event Operations

```typescript
async function saveCompactionEvent(
  sessionId: string,
  round: number,
  tokensBefore: number,
  tokensAfter: number,
  summaryContent: string
): Promise<CompactionEvent> {
  const id = crypto.randomUUID();
  const now = Date.now();
  
  await db.insert(compactionEvents).values({
    id,
    sessionId,
    round,
    createdAt: now,
    tokensBefore,
    tokensAfter,
    summaryContent,
  });
  
  return { id, sessionId, round, createdAt: now, tokensBefore, tokensAfter, summaryContent };
}

async function getLastCompactionEvent(sessionId: string): Promise<CompactionEvent | null> {
  const result = await db.select()
    .from(compactionEvents)
    .where(eq(compactionEvents.sessionId, sessionId))
    .orderBy(desc(compactionEvents.round))
    .limit(1);
  return result[0] ?? null;
}
```

---

## Transaction Safety

```typescript
async function performCompaction(
  sessionId: string,
  beforeSequence: number,
  summaryMessage: { role: string; content: string; tokenCount: number },
  metrics: { round: number; tokensBefore: number; tokensAfter: number }
): Promise<void> {
  // All operations in one transaction
  await db.transaction(async (tx) => {
    // 1. Save compaction event
    await tx.insert(compactionEvents).values({
      id: crypto.randomUUID(),
      sessionId,
      round: metrics.round,
      createdAt: Date.now(),
      tokensBefore: metrics.tokensBefore,
      tokensAfter: metrics.tokensAfter,
      summaryContent: summaryMessage.content,
    });
    
    // 2. Mark old messages as compacted
    await tx.update(messages)
      .set({ isCompacted: 1 })
      .where(and(
        eq(messages.sessionId, sessionId),
        lt(messages.sequence, beforeSequence)
      ));
    
    // 3. Insert summary message
    const lastMsg = await tx.select({ seq: messages.sequence })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.sequence))
      .limit(1);
    
    await tx.insert(messages).values({
      id: crypto.randomUUID(),
      sessionId,
      sequence: (lastMsg[0]?.seq ?? 0) + 1,
      role: 'assistant',
      content: summaryMessage.content,
      tokenCount: summaryMessage.tokenCount,
      isCompacted: 0,
      createdAt: Date.now(),
    });
  });
}
```

---

## Convert DB Messages to CoreMessage

```typescript
import type { CoreMessage } from 'ai';

function dbMessageToCoreMessage(msg: Message): CoreMessage {
  if (msg.role === 'tool') {
    // Tool messages have special structure
    const parsed = JSON.parse(msg.content);
    return {
      role: 'tool',
      content: parsed.content,
      toolCallId: parsed.toolCallId,
    };
  }
  
  if (msg.role === 'assistant' && msg.content.includes('"toolCalls"')) {
    const parsed = JSON.parse(msg.content);
    return {
      role: 'assistant',
      content: parsed.text || '',
      toolCalls: parsed.toolCalls,
    };
  }
  
  return {
    role: msg.role as 'system' | 'user' | 'assistant',
    content: msg.content,
  };
}

async function loadActiveMessages(sessionId: string): Promise<CoreMessage[]> {
  const dbMessages = await getActiveMessages(sessionId);
  return dbMessages.map(dbMessageToCoreMessage);
}
```

---

## File Location

Implement in `index.ts` within **SECTION 3: DATABASE SCHEMA**.
