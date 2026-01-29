import { drizzle, BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq, and, asc, desc, lt } from "drizzle-orm";
import type { ModelMessage } from "ai";

// =============================================================================
// SECTION 3: DATABASE SCHEMA
// =============================================================================

// Sessions table
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  status: text("status").notNull().$type<"active" | "completed" | "failed">(),
  task: text("task").notNull(),
});

// Messages table
export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id),
  sequence: integer("sequence").notNull(),
  role: text("role")
    .notNull()
    .$type<"system" | "user" | "assistant" | "tool">(),
  content: text("content").notNull(),
  tokenCount: integer("token_count").notNull(),
  isCompacted: integer("is_compacted").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});

// Compaction events table
export const compactionEvents = sqliteTable("compaction_events", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id),
  round: integer("round").notNull(),
  createdAt: integer("created_at").notNull(),
  tokensBefore: integer("tokens_before").notNull(),
  tokensAfter: integer("tokens_after").notNull(),
  summaryContent: text("summary_content").notNull(),
});

// Inferred types
export type Session = typeof sessions.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type CompactionEvent = typeof compactionEvents.$inferSelect;

// =============================================================================
// DATABASE INITIALIZATION
// =============================================================================

const DB_PATH = "./agent.db";

export function initDatabase(
  dbPath: string = DB_PATH
): BunSQLiteDatabase {
  const sqlite = new Database(dbPath);
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

// Initialize database
const db = initDatabase();

// =============================================================================
// SESSION OPERATIONS
// =============================================================================

export async function createSession(
  task: string,
  database: BunSQLiteDatabase = db
): Promise<Session> {
  const id = crypto.randomUUID();
  const now = Date.now();

  await database.insert(sessions).values({
    id,
    createdAt: now,
    status: "active",
    task,
  });

  return { id, createdAt: now, status: "active", task };
}

export async function updateSessionStatus(
  sessionId: string,
  status: "active" | "completed" | "failed",
  database: BunSQLiteDatabase = db
): Promise<void> {
  await database
    .update(sessions)
    .set({ status })
    .where(eq(sessions.id, sessionId));
}

export async function getSession(
  sessionId: string,
  database: BunSQLiteDatabase = db
): Promise<Session | null> {
  const result = await database
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return result[0] ?? null;
}

// =============================================================================
// MESSAGE OPERATIONS
// =============================================================================

export async function saveMessage(
  sessionId: string,
  role: "system" | "user" | "assistant" | "tool",
  content: string,
  tokenCount: number,
  database: BunSQLiteDatabase = db
): Promise<Message> {
  const id = crypto.randomUUID();
  const now = Date.now();

  // Get next sequence number
  const lastMsg = await database
    .select({ seq: messages.sequence })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(desc(messages.sequence))
    .limit(1);

  const sequence = (lastMsg[0]?.seq ?? 0) + 1;

  await database.insert(messages).values({
    id,
    sessionId,
    sequence,
    role,
    content,
    tokenCount,
    isCompacted: 0,
    createdAt: now,
  });

  return {
    id,
    sessionId,
    sequence,
    role,
    content,
    tokenCount,
    isCompacted: 0,
    createdAt: now,
  };
}

export async function getActiveMessages(
  sessionId: string,
  database: BunSQLiteDatabase = db
): Promise<Message[]> {
  return database
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.isCompacted, 0)))
    .orderBy(asc(messages.sequence));
}

export async function markMessagesCompacted(
  sessionId: string,
  beforeSequence: number,
  database: BunSQLiteDatabase = db
): Promise<void> {
  await database
    .update(messages)
    .set({ isCompacted: 1 })
    .where(
      and(
        eq(messages.sessionId, sessionId),
        lt(messages.sequence, beforeSequence),
        eq(messages.isCompacted, 0)
      )
    );
}

// =============================================================================
// COMPACTION EVENT OPERATIONS
// =============================================================================

export async function saveCompactionEvent(
  sessionId: string,
  round: number,
  tokensBefore: number,
  tokensAfter: number,
  summaryContent: string,
  database: BunSQLiteDatabase = db
): Promise<CompactionEvent> {
  const id = crypto.randomUUID();
  const now = Date.now();

  await database.insert(compactionEvents).values({
    id,
    sessionId,
    round,
    createdAt: now,
    tokensBefore,
    tokensAfter,
    summaryContent,
  });

  return {
    id,
    sessionId,
    round,
    createdAt: now,
    tokensBefore,
    tokensAfter,
    summaryContent,
  };
}

export async function getLastCompactionEvent(
  sessionId: string,
  database: BunSQLiteDatabase = db
): Promise<CompactionEvent | null> {
  const result = await database
    .select()
    .from(compactionEvents)
    .where(eq(compactionEvents.sessionId, sessionId))
    .orderBy(desc(compactionEvents.round))
    .limit(1);
  return result[0] ?? null;
}

// =============================================================================
// TRANSACTION-SAFE COMPACTION
// =============================================================================

export async function performCompaction(
  sessionId: string,
  beforeSequence: number,
  summaryMessage: { role: string; content: string; tokenCount: number },
  metrics: { round: number; tokensBefore: number; tokensAfter: number },
  database: BunSQLiteDatabase = db
): Promise<void> {
  // All operations in one transaction
  await database.transaction(async (tx: BunSQLiteDatabase) => {
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
    await tx
      .update(messages)
      .set({ isCompacted: 1 })
      .where(
        and(
          eq(messages.sessionId, sessionId),
          lt(messages.sequence, beforeSequence)
        )
      );

    // 3. Insert summary message
    const lastMsg = await tx
      .select({ seq: messages.sequence })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.sequence))
      .limit(1);

    await tx.insert(messages).values({
      id: crypto.randomUUID(),
      sessionId,
      sequence: (lastMsg[0]?.seq ?? 0) + 1,
      role: "assistant",
      content: summaryMessage.content,
      tokenCount: summaryMessage.tokenCount,
      isCompacted: 0,
      createdAt: Date.now(),
    });
  });
}

// =============================================================================
// CONVERT DB MESSAGES TO COREMESSAGE
// =============================================================================

export function dbMessageToCoreMessage(msg: Message): ModelMessage {
  if (msg.role === "tool") {
    // Tool messages require content as Array<ToolResultPart> in AI SDK v6
    const parsed = JSON.parse(msg.content);
    return {
      role: "tool",
      content: [
        {
          type: "tool-result" as const,
          toolCallId: parsed.toolCallId,
          toolName: parsed.toolName || "unknown",
          output: { type: "text" as const, value: JSON.stringify(parsed.result ?? parsed.content ?? "") },
        },
      ],
    };
  }

  if (msg.role === "assistant" && msg.content.includes('"toolCalls"')) {
    // Assistant messages with tool calls need TextPart or ToolCallPart array
    const parsed = JSON.parse(msg.content);
    const content: Array<
      | { type: "text"; text: string }
      | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
    > = [];

    if (parsed.text) {
      content.push({ type: "text", text: parsed.text });
    }

    if (parsed.toolCalls && Array.isArray(parsed.toolCalls)) {
      for (const call of parsed.toolCalls) {
        content.push({
          type: "tool-call",
          toolCallId: call.id || call.toolCallId,
          toolName: call.name || call.toolName,
          input: call.args || call.arguments || call.input || {},
        });
      }
    }

    return {
      role: "assistant",
      content: content.length > 0 ? content : "",
    };
  }

  return {
    role: msg.role as "system" | "user" | "assistant",
    content: msg.content,
  };
}

export async function loadActiveMessages(
  sessionId: string,
  database: BunSQLiteDatabase = db
): Promise<ModelMessage[]> {
  const dbMessages = await getActiveMessages(sessionId, database);
  return dbMessages.map(dbMessageToCoreMessage);
}

// =============================================================================
// TODO: Implement Docker container management
// =============================================================================
// - Start a container for the session
// - Execute commands inside the container
// - Clean up container when done

// =============================================================================
// TODO: Implement token estimation
// =============================================================================
// Simple heuristic: ~4 characters per token
const estimateTokens = (text: string): number => {
  // TODO: Implement
  return 0;
};

// =============================================================================
// TODO: Implement context compaction
// =============================================================================
// - Track total tokens used
// - When approaching limit, summarize old messages

// =============================================================================
// TODO: Define your agent tools
// =============================================================================
const tools = {
  // runCommand: tool({ ... }),
  // readFile: tool({ ... }),
  // writeFile: tool({ ... }),
  // listFiles: tool({ ... }),
};

// =============================================================================
// TODO: Implement the main agent loop with context compaction
// =============================================================================
// Use generateText with prepareStep to handle compaction, or use ToolLoopAgent

const main = async () => {
  // TODO: Implement
  // 1. Create or resume a session
  // 2. Start Docker container
  // 3. Run agent loop with compaction
  // 4. Persist messages
  // 5. Clean up

  console.log("Agent not implemented yet");
};

main().catch(console.error);
