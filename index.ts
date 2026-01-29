import { drizzle, BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq, and, asc, desc, lt } from "drizzle-orm";
import { tool } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";

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
// SECTION 5: DOCKER FUNCTIONS
// =============================================================================

// Docker configuration
export interface DockerConfig {
  image: string;
  containerPrefix: string;
  workdir: string;
  commandTimeoutMs: number;
}

export const DOCKER_CONFIG: DockerConfig = {
  image: "oven/bun:latest",
  containerPrefix: "coding-agent-",
  workdir: "/workspace",
  commandTimeoutMs: 60_000,
};

// Docker error types
export type DockerErrorCode =
  | "CONTAINER_START_FAILED"
  | "EXEC_FAILED"
  | "COMMAND_TIMEOUT";

export class DockerError extends Error {
  code: DockerErrorCode;
  constructor(message: string, code: DockerErrorCode) {
    super(message);
    this.name = "DockerError";
    this.code = code;
  }
}

// Execution result type
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Helper: Truncate long output
export function truncateOutput(
  output: string,
  maxLength: number = 10_000
): string {
  if (output.length <= maxLength) return output;
  return `${output.slice(0, maxLength)}\n[...truncated at ${maxLength} chars...]`;
}

// Helper: Resolve path to workspace
export function resolvePath(path: string): string {
  const cleanPath = path.replace(/^\/+/, "");
  return `${DOCKER_CONFIG.workdir}/${cleanPath}`;
}

// Start a Docker container for a session
export async function startContainer(sessionId: string): Promise<string> {
  const containerName = `${DOCKER_CONFIG.containerPrefix}${sessionId}`;

  const args = [
    "run",
    "-d",
    "--name",
    containerName,
    "-w",
    DOCKER_CONFIG.workdir,
    DOCKER_CONFIG.image,
    "tail",
    "-f",
    "/dev/null",
  ];

  console.log(`[Docker] Starting container: ${containerName}`);

  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    throw new DockerError(
      `Failed to start container: ${stderr.trim()}`,
      "CONTAINER_START_FAILED"
    );
  }

  // Return short container ID (first 12 chars)
  return stdout.trim().slice(0, 12);
}

// Execute a command inside a container
export async function execInContainer(
  containerId: string,
  command: string,
  timeoutMs: number = DOCKER_CONFIG.commandTimeoutMs
): Promise<ExecResult> {
  const proc = Bun.spawn(["docker", "exec", containerId, "sh", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  try {
    const exitCode = await proc.exited;
    clearTimeout(timeoutId);

    if (timedOut) {
      throw new DockerError(
        `Command timed out after ${timeoutMs}ms`,
        "COMMAND_TIMEOUT"
      );
    }

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    return {
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(stderr),
      exitCode,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof DockerError) throw error;
    throw new DockerError(`Command failed: ${error}`, "EXEC_FAILED");
  }
}

// Clean up a container
export async function cleanupContainer(containerId: string): Promise<void> {
  if (!containerId) return;

  console.log(`[Docker] Cleaning up: ${containerId}`);

  try {
    await Bun.spawn(["docker", "stop", "-t", "10", containerId]).exited;
    await Bun.spawn(["docker", "rm", "-f", containerId]).exited;
  } catch (error) {
    console.error(`[Docker] Cleanup failed: ${error}`);
  }
}

// File operations

export async function readFileInContainer(
  containerId: string,
  path: string
): Promise<ExecResult> {
  return execInContainer(containerId, `cat "${resolvePath(path)}"`);
}

export async function writeFileInContainer(
  containerId: string,
  path: string,
  content: string
): Promise<ExecResult> {
  const fullPath = resolvePath(path);

  // Use base64 encoding to safely transfer content without shell escaping issues
  const base64Content = Buffer.from(content).toString("base64");

  const command = `mkdir -p "$(dirname "${fullPath}")" && echo "${base64Content}" | base64 -d > "${fullPath}"`;
  return execInContainer(containerId, command);
}

export async function listDirectoryInContainer(
  containerId: string,
  path: string = "."
): Promise<ExecResult> {
  return execInContainer(containerId, `ls -la "${resolvePath(path)}"`);
}

// =============================================================================
// SECTION 6: TOKEN ESTIMATION
// =============================================================================

// Simple heuristic: ~4 characters per token
export const estimateTokens = (text: string): number => {
  return Math.ceil(text.length / 4);
};

// =============================================================================
// TODO: Implement context compaction
// =============================================================================
// - Track total tokens used
// - When approaching limit, summarize old messages

// =============================================================================
// SECTION 7: TOOLS
// =============================================================================

/**
 * Formats the result of a Docker exec command for return to the LLM.
 * Combines stdout, stderr, and exit code into a readable string.
 */
export function formatToolResult(result: ExecResult): string {
  let output = "";

  if (result.stdout) {
    output += result.stdout;
  }

  if (result.stderr) {
    output += output ? "\n" : "";
    output += `[stderr]\n${result.stderr}`;
  }

  output += `\n[exit code: ${result.exitCode}]`;

  return output;
}

/**
 * Creates the four agent tools bound to a specific container.
 * All tools execute inside the Docker container.
 */
export function createTools(containerId: string) {
  return {
    execute_command: tool({
      description:
        "Execute a shell command in the container. Use for running bun, npm, git, or any shell command.",
      inputSchema: z.object({
        command: z.string().describe("The command to execute"),
      }),
      execute: async ({ command }) => {
        try {
          const result = await execInContainer(containerId, command);
          return formatToolResult(result);
        } catch (error) {
          return `[Error] ${error instanceof Error ? error.message : "Unknown error"}`;
        }
      },
    }),

    read_file: tool({
      description:
        "Read the contents of a file. Path is relative to /workspace.",
      inputSchema: z.object({
        path: z.string().describe("Path to the file (relative to /workspace)"),
      }),
      execute: async ({ path }) => {
        try {
          const result = await readFileInContainer(containerId, path);
          if (result.exitCode !== 0) {
            return `Error reading file: ${result.stderr || "File not found"}`;
          }
          return result.stdout;
        } catch (error) {
          return `[Error] ${error instanceof Error ? error.message : "Unknown error"}`;
        }
      },
    }),

    write_file: tool({
      description:
        "Write content to a file. Creates parent directories if needed. Path is relative to /workspace.",
      inputSchema: z.object({
        path: z.string().describe("Path to the file (relative to /workspace)"),
        content: z.string().describe("Content to write to the file"),
      }),
      execute: async ({ path, content }) => {
        try {
          const result = await writeFileInContainer(containerId, path, content);
          if (result.exitCode !== 0) {
            return `Error writing file: ${result.stderr}`;
          }
          return `File written: ${path}`;
        } catch (error) {
          return `[Error] ${error instanceof Error ? error.message : "Unknown error"}`;
        }
      },
    }),

    list_directory: tool({
      description:
        "List contents of a directory. Path is relative to /workspace.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Path to the directory (relative to /workspace)")
          .default("."),
      }),
      execute: async ({ path }) => {
        try {
          const result = await listDirectoryInContainer(containerId, path);
          if (result.exitCode !== 0) {
            return `Error listing directory: ${result.stderr}`;
          }
          return result.stdout;
        } catch (error) {
          return `[Error] ${error instanceof Error ? error.message : "Unknown error"}`;
        }
      },
    }),
  };
}

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
