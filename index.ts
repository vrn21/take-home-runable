import { drizzle, BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq, and, asc, desc, lt } from "drizzle-orm";
import { tool } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { createInterface } from "readline";

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

const CONTENT_JSON_PREFIX = "__content_json__:";

export function dbMessageToCoreMessage(msg: Message): ModelMessage {
  if (msg.content.startsWith(CONTENT_JSON_PREFIX)) {
    try {
      const content = JSON.parse(msg.content.slice(CONTENT_JSON_PREFIX.length));
      return {
        role: msg.role as "system" | "user" | "assistant" | "tool",
        content,
      };
    } catch (e) {
      console.error("Failed to parse JSON content:", e);
      // Fallback to text if parse fails
      return {
        role: msg.role as "system" | "user" | "assistant",
        content: msg.content,
      };
    }
  }

  // Handle legacy/simple text messages
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
// SECTION 6.1: COMPACTION CONFIGURATION & TYPES
// =============================================================================

export interface CompactionConfig {
  modelContextLimit: number;
  systemReserve: number;
  outputReserve: number;
  safetyBuffer: number;
  thresholdPercent: number;
  recentMessagesToKeep: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  modelContextLimit: 128_000,  // GPT-4o / GPT-4-turbo
  systemReserve: 2_000,
  outputReserve: 4_000,
  safetyBuffer: 5_000,
  thresholdPercent: 0.80,
  recentMessagesToKeep: 10,
};

export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'claude-3-5-sonnet-20240620': 200_000,
  'claude-3-haiku-20240307': 200_000,
};

export interface CompactionSelection {
  messagesToCompact: ModelMessage[];
  messagesToKeep: ModelMessage[];
  previousSummary: string | null;
  boundaryIndex: number; // Index in the original message array where keeping begins
}

export interface CompactionResult {
  compactedMessages: ModelMessage[];
  boundaryIndex: number;
  compactionEvent: {
    round: number;
    tokensBefore: number;
    tokensAfter: number;
    summaryContent: string;
  };
}

// =============================================================================
// SECTION 6.2: TOKEN ESTIMATION FOR MESSAGE ARRAYS
// =============================================================================

/**
 * Estimate total tokens across all messages in the array.
 * Handles all message types: system, user, assistant, tool.
 */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let total = 0;

  for (const message of messages) {
    // Role contributes ~2 tokens
    total += 2;

    if (typeof message.content === 'string') {
      total += estimateTokens(message.content);
    } else if (Array.isArray(message.content)) {
      // Handle content parts (text, tool_call, tool_result)
      for (const part of message.content) {
        if ('text' in part && typeof part.text === 'string') {
          total += estimateTokens(part.text);
        } else if ('toolName' in part) {
          total += estimateTokens(part.toolName);
          // Check for V6 args (or legacy input)
          if ('args' in part) {
            total += estimateTokens(JSON.stringify(part.args));
          } else if ('input' in part) {
            total += estimateTokens(JSON.stringify(part.input));
          }
          
          // Check for V6 output (or legacy result)
          if ('output' in part) {
            total += estimateTokens(JSON.stringify(part.output));
          } else if ('result' in part) {
            total += estimateTokens(JSON.stringify(part.result));
          }
        }
      }
    }
  }

  return total;
}

// =============================================================================
// SECTION 6.3: COMPACTION THRESHOLD LOGIC
// =============================================================================

/**
 * Calculate the token threshold that triggers compaction.
 */
export function calculateThreshold(config: CompactionConfig): number {
  const available = config.modelContextLimit
    - config.systemReserve
    - config.outputReserve
    - config.safetyBuffer;
  return Math.floor(available * config.thresholdPercent);
}

/**
 * Determine if compaction should be triggered.
 * Called at the start of each agent step via prepareStep.
 */
export function shouldCompact(
  messages: ModelMessage[],
  config: CompactionConfig = DEFAULT_COMPACTION_CONFIG
): boolean {
  // Empty or minimal messages - nothing to compact
  if (messages.length <= config.recentMessagesToKeep + 1) {
    return false;
  }

  const tokenCount = estimateMessagesTokens(messages);
  const threshold = calculateThreshold(config);

  return tokenCount >= threshold;
}

// =============================================================================
// SECTION 6.4: MESSAGE SELECTION ALGORITHM
// =============================================================================

/**
 * Select which messages to compact and which to preserve.
 * 
 * CRITICAL: Tool calls and their results must stay together.
 * Orphaned tool messages break the LLM's understanding of state.
 */
export function selectMessagesToCompact(
  messages: ModelMessage[],
  keepLast: number = 10
): CompactionSelection {
  // Nothing to compact if too few messages
  if (messages.length <= keepLast + 1) {
    return {
      messagesToCompact: [],
      messagesToKeep: messages,
      previousSummary: null,
      boundaryIndex: 0,
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
      boundaryIndex: 0, // Nothing compacted implies boundary is at start (effectively)
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
    boundaryIndex,
  };
}

// =============================================================================
// SECTION 6.5: SUMMARY GENERATION
// =============================================================================

/**
 * Format messages into a readable string for summarization.
 */
export function formatMessagesForSummary(messages: ModelMessage[]): string {
  return messages.map((msg, idx) => {
    const role = msg.role.toUpperCase();
    let content = '';

    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map(part => {
        if ('text' in part) return part.text;
        
        // Handle tool calls (V6 args or legacy input)
        if ('toolName' in part) {
            const args = 'args' in part ? part.args : ('input' in part ? part.input : {});
            if (!('output' in part) && !('result' in part)) {
                 return `[Tool: ${part.toolName}(${JSON.stringify(args)})]`;
            }
        }

        // Handle tool results (V6 output or legacy result)
        if ('toolName' in part) {
           const outputVal = 'output' in part ? part.output : ('result' in part ? part.result : null);
           if (outputVal !== null) {
              const outputStr = JSON.stringify(outputVal);
              return `[Result: ${outputStr.slice(0, 500)}${outputStr.length > 500 ? '...' : ''}]`;
           }
        }
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

/**
 * Extract the original user task from the first user message.
 */
export function extractOriginalTask(messages: ModelMessage[]): string {
  for (const msg of messages) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      return msg.content;
    }
  }
  return 'Unknown task';
}

/**
 * Generate a structured summary of compacted messages using LLM.
 */
export async function generateSummary(
  messagesToCompact: ModelMessage[],
  previousSummary: string | null,
  originalTask: string,
  compactionRound: number,
  model: LanguageModel
): Promise<string> {
  const { generateText: genText } = await import('ai');
  
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

  const { text } = await genText({
    model,
    system: systemPrompt,
    prompt: userPrompt,
    maxOutputTokens: 1000,
    temperature: 0.3,
  });

  return text;
}

// =============================================================================
// SECTION 6.6: MAIN COMPACTION FUNCTIONS
// =============================================================================

/**
 * Perform context compaction on the message array.
 */
export async function compact(
  messages: ModelMessage[],
  sessionId: string,
  model: LanguageModel,
  config: CompactionConfig = DEFAULT_COMPACTION_CONFIG
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
      boundaryIndex: 0,
      compactionEvent: {
        round: 0,
        tokensBefore,
        tokensAfter: tokensBefore,
        summaryContent: '',
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
  const summaryMessage: ModelMessage = {
    role: 'assistant',
    content: summaryContent,
  };

  const compactedMessages: ModelMessage[] = [
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
    boundaryIndex: selection.boundaryIndex,
    compactionEvent: {
      round,
      tokensBefore,
      tokensAfter,
      summaryContent,
    },
  };
}

/**
 * Safe wrapper for compaction with error handling and persistence.
 */
export async function safeCompact(
  messages: ModelMessage[],
  sessionId: string,
  model: LanguageModel,
  config?: CompactionConfig
): Promise<ModelMessage[]> {
  try {
    const result = await compact(messages, sessionId, model, config);

    // Skip if no compaction happened
    if (result.compactionEvent.round === 0) {
      return result.compactedMessages;
    }

    // Get the boundary sequence for marking messages
    const activeMessages = await getActiveMessages(sessionId);
    
    // Safety check: ensure we have a valid boundary index
    if (result.boundaryIndex === undefined || result.boundaryIndex >= activeMessages.length) {
        throw new Error(`Invalid boundary index ${result.boundaryIndex} for ${activeMessages.length} messages`);
    }

    // Map the array index key from selection logic to the actual DB sequence number
    const boundarySequence = activeMessages[result.boundaryIndex].sequence;

    // Persist compaction event and mark messages atomically
    await performCompaction(
      sessionId,
      boundarySequence,
      {
        role: 'assistant',
        content: result.compactionEvent.summaryContent,
        tokenCount: estimateTokens(result.compactionEvent.summaryContent),
      },
      {
        round: result.compactionEvent.round,
        tokensBefore: result.compactionEvent.tokensBefore,
        tokensAfter: result.compactionEvent.tokensAfter,
      }
    );

    return result.compactedMessages;

  } catch (error) {
    // Log but don't fail the agent loop
    console.error('[Compaction] Failed, continuing without compaction:', error);
    return messages;
  }
}

// Import LanguageModel type for type annotations
import type { LanguageModel } from 'ai';

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
// SECTION 8: AGENT LOOP
// =============================================================================

import { generateText, stepCountIs } from "ai";

// System prompt defining agent behavior
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
- Minimal comments (code should be self-documenting)
- Follow language/framework conventions
- Test your work before declaring completion

CONSTRAINTS:
- Do not ask clarifying questions - make reasonable assumptions
- Focus on implementation, minimize explanation`;

// Agent result type
export interface AgentResult {
  success: boolean;
  finalMessage: string;
  stepsExecuted: number;
}

/**
 * Initialize session with system and user messages.
 * Persists both to database before starting the agent loop.
 */
export async function initializeMessages(
  sessionId: string,
  task: string
): Promise<ModelMessage[]> {
  // Save system message
  await saveMessage(
    sessionId,
    "system",
    SYSTEM_PROMPT,
    estimateTokens(SYSTEM_PROMPT)
  );

  // Save user message
  await saveMessage(sessionId, "user", task, estimateTokens(task));

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: task },
  ];
}

/**
 * Serialize message content to a string for storage.
 * Handles complex content types (tool calls, tool results).
 */
export function serializeMessageContent(msg: ModelMessage): string {
  if (typeof msg.content === "string") {
    return msg.content;
  }
  
  // Use prefix for complex content to ensure safe round-tripping
  return CONTENT_JSON_PREFIX + JSON.stringify(msg.content);
}

/**
 * Persist messages from a completed step to the database.
 * Called by onStepFinish callback after each agent step.
 */
export async function persistStepMessages(
  sessionId: string,
  newMessages: ModelMessage[]
): Promise<void> {
  for (const msg of newMessages) {
    const content = serializeMessageContent(msg);
    const tokens = estimateTokens(content);
    await saveMessage(sessionId, msg.role as "system" | "user" | "assistant" | "tool", content, tokens);
  }
}

/**
 * Main agent loop using Vercel AI SDK's generateText with multi-step support.
 * Uses prepareStep for context compaction and onStepFinish for persistence.
 */
export async function runAgent(
  sessionId: string,
  task: string,
  containerId: string,
  model: LanguageModel
): Promise<AgentResult> {
  // Load or initialize messages
  let messages = await loadActiveMessages(sessionId);
  if (messages.length === 0) {
    messages = await initializeMessages(sessionId, task);
  }

  console.log(`[Agent] Starting with ${messages.length} messages`);

  // NOTE: System prompt is messages[0], do NOT pass separate 'system' parameter
  const result = await generateText({
    model,
    messages,
    tools: createTools(containerId),
    stopWhen: stepCountIs(50),

    prepareStep: async ({ messages: stepMessages }) => {
      // Check for compaction before each step
      const tokenCount = estimateMessagesTokens(stepMessages);
      console.log(`[prepareStep] Token count: ${tokenCount}`);

      if (shouldCompact(stepMessages)) {
        console.log("[Agent] Triggering compaction...");
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

  const finalText = result.text || "Task completed.";
  console.log(`[Agent] Completed in ${result.steps.length} steps`);

  return {
    success: true,
    finalMessage: finalText,
    stepsExecuted: result.steps.length,
  };
}

/**
 * Wrapper for runAgent with error handling.
 * Logs final state on error for debugging.
 */
export async function runAgentWithErrorHandling(
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

// =============================================================================
// SECTION 9: SESSION LIFECYCLE
// =============================================================================

// Module-level variable for graceful shutdown container tracking
let currentContainerId: string | null = null;

/**
 * Run a complete session: create session, start container, run agent, cleanup.
 */
export async function runSession(task: string, model: LanguageModel): Promise<AgentResult> {
  // 1. Create session
  const session = await createSession(task);
  console.log(`[Session] Created: ${session.id}`);

  let containerId: string | null = null;

  try {
    // 2. Start Docker container
    containerId = await startContainer(session.id);
    currentContainerId = containerId; // Track for graceful shutdown
    console.log(`[Session] Container started: ${containerId}`);

    // 3. Run agent loop with compaction
    const result = await runAgentWithErrorHandling(
      session.id,
      task,
      containerId,
      model
    );

    // 4. Update session status to completed
    await updateSessionStatus(session.id, "completed");
    console.log(`[Session] Completed: ${session.id}`);

    return result;
  } catch (error) {
    // Update session status to failed
    await updateSessionStatus(session.id, "failed");
    console.error(`[Session] Failed: ${session.id}`);
    throw error;
  } finally {
    // 5. Always cleanup container
    if (containerId) {
      await cleanupContainer(containerId);
      currentContainerId = null;
      console.log(`[Session] Container cleaned up`);
    }
  }
}

// =============================================================================
// SECTION 10: MAIN ENTRY POINT
// =============================================================================

/**
 * Validate required environment variables before starting.
 * Ensures API keys are present.
 */
export function validateEnvironment(): void {
  const hasApiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;

  if (!hasApiKey) {
    console.error("Missing required environment variable.");
    console.error("Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env or export before running.");
    process.exit(1);
  }
}

/**
 * Get the configured LLM model based on environment.
 */
export async function getModel(): Promise<LanguageModel> {
  if (process.env.ANTHROPIC_API_KEY) {
    const { anthropic } = await import("@ai-sdk/anthropic");
    return anthropic(process.env.MODEL || "claude-3-5-sonnet-20241022");
  }
  if (process.env.OPENAI_API_KEY) {
    const { openai } = await import("@ai-sdk/openai");
    return openai(process.env.MODEL || "gpt-4o");
  }
  throw new Error("No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
}

/**
 * Setup handlers for graceful shutdown on SIGINT/SIGTERM.
 * Ensures Docker container is cleaned up before exit.
 */
export function setupGracefulShutdown(): void {
  const cleanup = async (signal: string) => {
    console.log(`\n[Shutdown] Received ${signal}, cleaning up...`);

    if (currentContainerId) {
      await cleanupContainer(currentContainerId);
      console.log("[Shutdown] Container cleaned up");
    }

    process.exit(0);
  };

  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));
}

/**
 * Read multiline input from stdin.
 * Submit by pressing Enter twice (empty line ends input).
 */
export async function readMultilineInput(): Promise<string> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.on("line", (line) => {
      // Two consecutive empty lines = submit
      if (line === "" && lines.length > 0 && lines[lines.length - 1] === "") {
        rl.close();
        resolve(lines.slice(0, -1).join("\n"));
      } else {
        lines.push(line);
      }
    });

    rl.on("close", () => {
      // If closed without double-enter (e.g., Ctrl+D), return what we have
      if (lines.length > 0) {
        resolve(lines.join("\n"));
      } else {
        resolve("");
      }
    });
  });
}

/**
 * Main entry point: read task and run the agent.
 */
async function main(): Promise<void> {
  console.log("Context-Compacting Coding Agent");
  console.log("================================\n");

  // Validate environment
  validateEnvironment();

  // Setup signal handlers for graceful shutdown
  setupGracefulShutdown();

  console.log("Enter your task (press Enter twice to submit):\n");

  const task = await readMultilineInput();

  if (!task.trim()) {
    console.error("No task provided. Exiting.");
    process.exit(1);
  }

  console.log("\n[Starting session...]\n");

  try {
    const model = await getModel();
    const result = await runSession(task, model);

    console.log("\n================================");
    console.log("Task completed!");
    console.log(`Steps executed: ${result.stepsExecuted}`);
    console.log(`\nFinal response:\n${result.finalMessage}`);
    process.exit(0);
  } catch (error) {
    console.error("\n================================");
    console.error("Session failed:", error);
    process.exit(1);
  }
}

// Only run main when executed directly (not when imported as a module)
if (import.meta.main) {
  main();
}
