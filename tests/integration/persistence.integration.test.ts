import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync, existsSync } from "node:fs";

import {
  initDatabase,
  createSession,
  updateSessionStatus,
  getSession,
  saveMessage,
  getActiveMessages,
  performCompaction,
  getLastCompactionEvent,
  loadActiveMessages,
} from "../../index";

const TEST_DB_PATH = "./test-persistence-integration.db";

describe("Persistence Layer Integration Tests", () => {
  let testDb: ReturnType<typeof initDatabase>;

  beforeAll(() => {
    testDb = initDatabase(TEST_DB_PATH);
  });

  afterAll(() => {
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  describe("Full Compaction Flow", () => {
    test("performCompaction should atomically update all tables", async () => {
      // 1. Create a session
      const session = await createSession("Integration test task", testDb);

      // 2. Add several messages
      await saveMessage(session.id, "system", "You are a coding assistant.", 20, testDb);
      await saveMessage(session.id, "user", "Can you help me with a function?", 30, testDb);
      await saveMessage(session.id, "assistant", "Sure! What kind of function do you need?", 40, testDb);
      await saveMessage(session.id, "user", "A function to sort an array.", 25, testDb);
      await saveMessage(session.id, "assistant", "Here is a sorting function: ...", 100, testDb);

      // Verify we have 5 active messages
      const activeBeforeCompaction = await getActiveMessages(session.id, testDb);
      expect(activeBeforeCompaction.length).toBe(5);

      // 3. Perform compaction (compact messages before sequence 5)
      await performCompaction(
        session.id,
        5,
        {
          role: "assistant",
          content: "Summary: User requested help with a sorting function.",
          tokenCount: 50,
        },
        {
          round: 1,
          tokensBefore: 215,
          tokensAfter: 50,
        },
        testDb
      );

      // 4. Verify compaction results
      const activeAfterCompaction = await getActiveMessages(session.id, testDb);
      
      // Should have the last original message (sequence 5) + the new summary message (sequence 6)
      expect(activeAfterCompaction.length).toBe(2);
      expect(activeAfterCompaction[0].content).toBe("Here is a sorting function: ...");
      expect(activeAfterCompaction[1].content).toBe("Summary: User requested help with a sorting function.");

      // Verify compaction event was recorded
      const lastEvent = await getLastCompactionEvent(session.id, testDb);
      expect(lastEvent).not.toBeNull();
      expect(lastEvent!.round).toBe(1);
      expect(lastEvent!.tokensBefore).toBe(215);
      expect(lastEvent!.tokensAfter).toBe(50);
    });

    test("performCompaction should handle multiple compaction rounds", async () => {
      const session = await createSession("Multi-round compaction test", testDb);

      // Add initial messages
      await saveMessage(session.id, "user", "Message 1", 10, testDb);
      await saveMessage(session.id, "assistant", "Response 1", 15, testDb);
      await saveMessage(session.id, "user", "Message 2", 10, testDb);

      // First compaction
      await performCompaction(
        session.id,
        3,
        { role: "assistant", content: "Summary round 1", tokenCount: 20 },
        { round: 1, tokensBefore: 35, tokensAfter: 20 },
        testDb
      );

      // Add more messages
      await saveMessage(session.id, "user", "Message 3", 10, testDb);
      await saveMessage(session.id, "assistant", "Response 3", 15, testDb);

      // Second compaction
      await performCompaction(
        session.id,
        6,
        { role: "assistant", content: "Summary round 2", tokenCount: 25 },
        { round: 2, tokensBefore: 65, tokensAfter: 25 },
        testDb
      );

      // Verify results
      const activeMessages = await getActiveMessages(session.id, testDb);
      expect(activeMessages.length).toBe(2);

      const lastEvent = await getLastCompactionEvent(session.id, testDb);
      expect(lastEvent!.round).toBe(2);
    });
  });

  describe("Session Lifecycle", () => {
    test("complete session lifecycle: create → add messages → compact → complete", async () => {
      // 1. Create session
      const session = await createSession("Full lifecycle test", testDb);
      expect(session.status).toBe("active");

      // 2. Add messages
      await saveMessage(session.id, "system", "System message", 10, testDb);
      await saveMessage(session.id, "user", "User request", 15, testDb);
      await saveMessage(session.id, "assistant", "Assistant response", 20, testDb);

      // 3. Verify loadActiveMessages returns CoreMessage format
      const coreMessages = await loadActiveMessages(session.id, testDb);
      expect(coreMessages.length).toBe(3);
      expect(coreMessages[0].role).toBe("system");
      expect(coreMessages[1].role).toBe("user");
      expect(coreMessages[2].role).toBe("assistant");

      // 4. Compact
      await performCompaction(
        session.id,
        3,
        { role: "assistant", content: "Compacted summary", tokenCount: 15 },
        { round: 1, tokensBefore: 45, tokensAfter: 15 },
        testDb
      );

      // 5. Complete session
      await updateSessionStatus(session.id, "completed", testDb);
      const completedSession = await getSession(session.id, testDb);
      expect(completedSession!.status).toBe("completed");
    });

    test("failed session lifecycle", async () => {
      const session = await createSession("Failed lifecycle test", testDb);
      await saveMessage(session.id, "user", "User request", 10, testDb);

      // Mark as failed
      await updateSessionStatus(session.id, "failed", testDb);
      const failedSession = await getSession(session.id, testDb);
      expect(failedSession!.status).toBe("failed");
    });
  });

  describe("Edge Cases", () => {
    test("compaction with no messages to compact", async () => {
      const session = await createSession("Empty compaction test", testDb);

      // Just add one message
      await saveMessage(session.id, "user", "Only message", 10, testDb);

      // Compact with beforeSequence = 1 (nothing before sequence 1)
      await performCompaction(
        session.id,
        1,
        { role: "assistant", content: "Empty summary", tokenCount: 5 },
        { round: 1, tokensBefore: 10, tokensAfter: 5 },
        testDb
      );

      // Original message should still be active + summary message
      const active = await getActiveMessages(session.id, testDb);
      expect(active.length).toBe(2);
    });

    test("multiple sessions should be isolated", async () => {
      const session1 = await createSession("Session 1", testDb);
      const session2 = await createSession("Session 2", testDb);

      await saveMessage(session1.id, "user", "Message in session 1", 10, testDb);
      await saveMessage(session2.id, "user", "Message in session 2", 10, testDb);

      const messages1 = await getActiveMessages(session1.id, testDb);
      const messages2 = await getActiveMessages(session2.id, testDb);

      expect(messages1.length).toBe(1);
      expect(messages1[0].content).toBe("Message in session 1");
      expect(messages2.length).toBe(1);
      expect(messages2[0].content).toBe("Message in session 2");
    });
  });
});
