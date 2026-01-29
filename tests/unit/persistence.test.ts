import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle, BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { unlinkSync, existsSync } from "node:fs";

import {
  sessions,
  messages,
  compactionEvents,
  initDatabase,
  createSession,
  updateSessionStatus,
  getSession,
  saveMessage,
  getActiveMessages,
  markMessagesCompacted,
  saveCompactionEvent,
  getLastCompactionEvent,
  dbMessageToCoreMessage,
  loadActiveMessages,
  type Session,
  type Message,
  type CompactionEvent,
} from "../../index";

const TEST_DB_PATH = "./test-persistence.db";

describe("Persistence Layer Unit Tests", () => {
  let testDb: BunSQLiteDatabase;

  beforeAll(() => {
    // Initialize test database
    testDb = initDatabase(TEST_DB_PATH);
  });

  afterAll(() => {
    // Clean up test database
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  describe("Session Operations", () => {
    test("createSession should create a new session with active status", async () => {
      const session = await createSession("Test task", testDb);

      expect(session.id).toBeDefined();
      expect(session.task).toBe("Test task");
      expect(session.status).toBe("active");
      expect(session.createdAt).toBeLessThanOrEqual(Date.now());
    });

    test("getSession should retrieve an existing session", async () => {
      const created = await createSession("Get session test", testDb);
      const retrieved = await getSession(created.id, testDb);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.task).toBe("Get session test");
    });

    test("getSession should return null for non-existent session", async () => {
      const result = await getSession("non-existent-id", testDb);
      expect(result).toBeNull();
    });

    test("updateSessionStatus should update session status", async () => {
      const session = await createSession("Status update test", testDb);

      await updateSessionStatus(session.id, "completed", testDb);
      const updated = await getSession(session.id, testDb);

      expect(updated!.status).toBe("completed");
    });

    test("updateSessionStatus should update to failed status", async () => {
      const session = await createSession("Failed status test", testDb);

      await updateSessionStatus(session.id, "failed", testDb);
      const updated = await getSession(session.id, testDb);

      expect(updated!.status).toBe("failed");
    });
  });

  describe("Message Operations", () => {
    let testSessionId: string;

    beforeEach(async () => {
      const session = await createSession("Message test session", testDb);
      testSessionId = session.id;
    });

    test("saveMessage should create a new message with sequence 1", async () => {
      const msg = await saveMessage(
        testSessionId,
        "user",
        "Hello, world!",
        10,
        testDb
      );

      expect(msg.id).toBeDefined();
      expect(msg.sessionId).toBe(testSessionId);
      expect(msg.sequence).toBe(1);
      expect(msg.role).toBe("user");
      expect(msg.content).toBe("Hello, world!");
      expect(msg.tokenCount).toBe(10);
      expect(msg.isCompacted).toBe(0);
    });

    test("saveMessage should auto-increment sequence", async () => {
      const msg1 = await saveMessage(testSessionId, "user", "First", 5, testDb);
      const msg2 = await saveMessage(
        testSessionId,
        "assistant",
        "Second",
        8,
        testDb
      );
      const msg3 = await saveMessage(testSessionId, "user", "Third", 6, testDb);

      expect(msg1.sequence).toBe(1);
      expect(msg2.sequence).toBe(2);
      expect(msg3.sequence).toBe(3);
    });

    test("getActiveMessages should return non-compacted messages in order", async () => {
      await saveMessage(testSessionId, "user", "First", 5, testDb);
      await saveMessage(testSessionId, "assistant", "Second", 8, testDb);
      await saveMessage(testSessionId, "user", "Third", 6, testDb);

      const activeMessages = await getActiveMessages(testSessionId, testDb);

      expect(activeMessages.length).toBe(3);
      expect(activeMessages[0].content).toBe("First");
      expect(activeMessages[1].content).toBe("Second");
      expect(activeMessages[2].content).toBe("Third");
    });

    test("markMessagesCompacted should mark messages before sequence as compacted", async () => {
      await saveMessage(testSessionId, "user", "First", 5, testDb);
      await saveMessage(testSessionId, "assistant", "Second", 8, testDb);
      await saveMessage(testSessionId, "user", "Third", 6, testDb);

      await markMessagesCompacted(testSessionId, 3, testDb);
      const activeMessages = await getActiveMessages(testSessionId, testDb);

      expect(activeMessages.length).toBe(1);
      expect(activeMessages[0].content).toBe("Third");
    });

    test("markMessagesCompacted should not re-compact already compacted messages", async () => {
      await saveMessage(testSessionId, "user", "First", 5, testDb);
      await saveMessage(testSessionId, "assistant", "Second", 8, testDb);

      // Mark first message compacted
      await markMessagesCompacted(testSessionId, 2, testDb);
      
      // Add new message
      await saveMessage(testSessionId, "user", "Third", 6, testDb);

      // Mark up to sequence 3 - should only affect sequence 2
      await markMessagesCompacted(testSessionId, 3, testDb);
      
      const activeMessages = await getActiveMessages(testSessionId, testDb);
      expect(activeMessages.length).toBe(1);
      expect(activeMessages[0].content).toBe("Third");
    });
  });

  describe("Compaction Event Operations", () => {
    let testSessionId: string;

    beforeEach(async () => {
      const session = await createSession("Compaction test session", testDb);
      testSessionId = session.id;
    });

    test("saveCompactionEvent should create a new compaction event", async () => {
      const event = await saveCompactionEvent(
        testSessionId,
        1,
        5000,
        1000,
        "Summary of compacted content",
        testDb
      );

      expect(event.id).toBeDefined();
      expect(event.sessionId).toBe(testSessionId);
      expect(event.round).toBe(1);
      expect(event.tokensBefore).toBe(5000);
      expect(event.tokensAfter).toBe(1000);
      expect(event.summaryContent).toBe("Summary of compacted content");
    });

    test("getLastCompactionEvent should return the most recent event", async () => {
      await saveCompactionEvent(testSessionId, 1, 5000, 1000, "First summary", testDb);
      await saveCompactionEvent(testSessionId, 2, 6000, 1500, "Second summary", testDb);
      await saveCompactionEvent(testSessionId, 3, 7000, 2000, "Third summary", testDb);

      const lastEvent = await getLastCompactionEvent(testSessionId, testDb);

      expect(lastEvent).not.toBeNull();
      expect(lastEvent!.round).toBe(3);
      expect(lastEvent!.summaryContent).toBe("Third summary");
    });

    test("getLastCompactionEvent should return null when no events exist", async () => {
      const result = await getLastCompactionEvent(testSessionId, testDb);
      expect(result).toBeNull();
    });
  });

  describe("CoreMessage Conversion", () => {
    test("dbMessageToCoreMessage should convert user message", () => {
      const dbMsg: Message = {
        id: "1",
        sessionId: "session-1",
        sequence: 1,
        role: "user",
        content: "Hello",
        tokenCount: 5,
        isCompacted: 0,
        createdAt: Date.now(),
      };

      const coreMsg = dbMessageToCoreMessage(dbMsg);

      expect(coreMsg.role).toBe("user");
      expect(coreMsg.content).toBe("Hello");
    });

    test("dbMessageToCoreMessage should convert assistant message", () => {
      const dbMsg: Message = {
        id: "2",
        sessionId: "session-1",
        sequence: 2,
        role: "assistant",
        content: "Hi there!",
        tokenCount: 8,
        isCompacted: 0,
        createdAt: Date.now(),
      };

      const coreMsg = dbMessageToCoreMessage(dbMsg);

      expect(coreMsg.role).toBe("assistant");
      expect(coreMsg.content).toBe("Hi there!");
    });

    test("dbMessageToCoreMessage should convert system message", () => {
      const dbMsg: Message = {
        id: "3",
        sessionId: "session-1",
        sequence: 1,
        role: "system",
        content: "You are a helpful assistant.",
        tokenCount: 15,
        isCompacted: 0,
        createdAt: Date.now(),
      };

      const coreMsg = dbMessageToCoreMessage(dbMsg);

      expect(coreMsg.role).toBe("system");
      expect(coreMsg.content).toBe("You are a helpful assistant.");
    });

    test("dbMessageToCoreMessage should parse tool message JSON for AI SDK v6", () => {
      const dbMsg: Message = {
        id: "4",
        sessionId: "session-1",
        sequence: 3,
        role: "tool",
        content: JSON.stringify({
          toolCallId: "call-123",
          toolName: "readFile",
          result: { data: "file contents" },
        }),
        tokenCount: 20,
        isCompacted: 0,
        createdAt: Date.now(),
      };

      const coreMsg = dbMessageToCoreMessage(dbMsg);

      expect(coreMsg.role).toBe("tool");
      // AI SDK v6 ToolModelMessage has content as Array<ToolResultPart>
      expect(Array.isArray(coreMsg.content)).toBe(true);
      const toolContent = coreMsg.content as Array<{ type: string; toolCallId: string; toolName: string }>;
      expect(toolContent[0].type).toBe("tool-result");
      expect(toolContent[0].toolCallId).toBe("call-123");
      expect(toolContent[0].toolName).toBe("readFile");
    });

    test("dbMessageToCoreMessage should parse assistant with toolCalls for AI SDK v6", () => {
      const dbMsg: Message = {
        id: "5",
        sessionId: "session-1",
        sequence: 2,
        role: "assistant",
        content: JSON.stringify({
          text: "Let me help you",
          toolCalls: [{ id: "call-1", name: "readFile", args: { path: "/test" } }],
        }),
        tokenCount: 25,
        isCompacted: 0,
        createdAt: Date.now(),
      };

      const coreMsg = dbMessageToCoreMessage(dbMsg);

      expect(coreMsg.role).toBe("assistant");
      // AI SDK v6 AssistantModelMessage with toolCalls has content as Array<TextPart | ToolCallPart>
      expect(Array.isArray(coreMsg.content)).toBe(true);
      const content = coreMsg.content as Array<{ type: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown }>;
      expect(content[0].type).toBe("text");
      expect(content[0].text).toBe("Let me help you");
      expect(content[1].type).toBe("tool-call");
      expect(content[1].toolCallId).toBe("call-1");
      expect(content[1].toolName).toBe("readFile");
      expect(content[1].input).toEqual({ path: "/test" });
    });
  });
});
