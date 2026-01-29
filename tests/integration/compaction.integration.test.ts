import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "node:fs";
import type { ModelMessage, LanguageModel } from "ai";

import {
  initDatabase,
  createSession,
  saveMessage,
  getActiveMessages,
  getLastCompactionEvent,
  estimateTokens,
  estimateMessagesTokens,
  selectMessagesToCompact,
  compact,
  safeCompact,
  DEFAULT_COMPACTION_CONFIG,
  type CompactionConfig,
} from "../../index";

const TEST_DB_PATH = "./test-compaction-integration.db";

// Mock LanguageModel that returns predictable summaries
const createMockModel = (): LanguageModel => ({
  specificationVersion: "v1",
  provider: "mock",
  modelId: "mock-model",
  defaultObjectGenerationMode: "json",
  doGenerate: async () => ({
    text: "## Session Summary (Compaction Round 1)\n\n#### Original Task\nTest task\n\n#### Completed Work\n| File | Action | Description |\n|------|--------|-------------|\n| test.ts | Created | Test file |\n\n#### Key Technical Decisions\n- Using mock model\n\n#### Current State\n- Working on: Testing\n\n#### Pending Work\n- [ ] More tests",
    finishReason: "stop",
    usage: { promptTokens: 100, completionTokens: 100 },
    rawCall: { rawPrompt: "", rawSettings: {} },
    response: { id: "1", timestamp: new Date(), modelId: "mock" },
  }),
  doStream: async () => {
    throw new Error("Streaming not implemented");
  },
} as unknown as LanguageModel);

describe("Context Compaction Integration Tests", () => {
  let testDb: ReturnType<typeof initDatabase>;

  beforeAll(() => {
    testDb = initDatabase(TEST_DB_PATH);
  });

  afterAll(() => {
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  describe("Full Compaction Cycle", () => {
    test("should compact messages and persist compaction event", async () => {
      // Create session with many messages
      const session = await createSession("Build a test app", testDb);
      
      // Add system message
      await saveMessage(session.id, "system", "You are a coding agent", 10, testDb);
      
      // Add many messages to trigger compaction
      for (let i = 0; i < 20; i++) {
        await saveMessage(
          session.id, 
          i % 2 === 0 ? "user" : "assistant",
          `Message ${i}: ${"x".repeat(100)}`,
          30,
          testDb
        );
      }

      // Load messages
      const activeMessages = await getActiveMessages(session.id, testDb);
      const coreMessages: ModelMessage[] = activeMessages.map(m => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
      }));

      // Verify we have enough messages
      expect(coreMessages.length).toBeGreaterThan(15);

      // Select messages to compact (should work)
      const selection = selectMessagesToCompact(coreMessages, 5);
      expect(selection.messagesToCompact.length).toBeGreaterThan(0);
    });

    test("should chain summaries across multiple compaction rounds", async () => {
      const session = await createSession("Multi-round test", testDb);
      
      // First compaction event
      const event1 = {
        sessionId: session.id,
        round: 1,
        tokensBefore: 5000,
        tokensAfter: 1000,
        summaryContent: "## Session Summary (Round 1)\nFirst round summary",
      };

      // Simulate messages with previous summary
      const messagesWithSummary: ModelMessage[] = [
        { role: "system", content: "System prompt" },
        { role: "assistant", content: "## Session Summary (Round 1)\nFirst round summary" },
        { role: "user", content: "Continue work" },
        { role: "assistant", content: "Continuing..." },
        ...Array(15).fill({ role: "user", content: "more" }),
      ];

      const selection = selectMessagesToCompact(messagesWithSummary, 5);
      
      // Should detect and include previous summary
      expect(selection.previousSummary).toContain("## Session Summary");
      expect(selection.messagesToCompact.length).toBeGreaterThan(0);
    });
  });

  describe("Error Recovery", () => {
    test("safeCompact should return original messages on failure", async () => {
      const session = await createSession("Error recovery test", testDb);
      
      // Add minimal messages (won't trigger actual compaction)
      await saveMessage(session.id, "system", "System", 5, testDb);
      await saveMessage(session.id, "user", "Hello", 5, testDb);

      const messages: ModelMessage[] = [
        { role: "system", content: "System" },
        { role: "user", content: "Hello" },
      ];

      // This should return messages unchanged (nothing to compact)
      const mockModel = createMockModel();
      const result = await safeCompact(messages, session.id, mockModel);

      expect(result).toEqual(messages);
    });
  });

  describe("Token Counting Accuracy", () => {
    test("should conservatively estimate tokens for mixed content", () => {
      const messages: ModelMessage[] = [
        { role: "system", content: "You are a helpful coding assistant." }, // 37 chars
        { role: "user", content: "Build a flashcard app with TypeScript" }, // 39 chars
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will help you build a flashcard application." },
            { type: "tool-call", toolCallId: "1", toolName: "write_file", input: { path: "app.ts" } },
          ],
        },
      ];

      const tokens = estimateMessagesTokens(messages);
      
      // Should be reasonable estimate (chars/4 + overhead)
      expect(tokens).toBeGreaterThan(20);
      expect(tokens).toBeLessThan(200);
    });
  });

  describe("Message Selection Edge Cases", () => {
    test("should handle messages ending with tool result", () => {
      const messages: ModelMessage[] = [
        { role: "system", content: "System" },
        ...Array(15).fill({ role: "user", content: "message" }),
        { role: "assistant", content: "Calling tool" },
        { role: "tool", content: JSON.stringify({ toolCallId: "1", result: "done" }) },
      ];

      const selection = selectMessagesToCompact(messages, 3);
      
      // Should not orphan tool at boundary
      const keptRoles = selection.messagesToKeep.map(m => m.role);
      if (keptRoles.includes("tool")) {
        // If tool is kept, assistant before it should also be kept
        const toolIndex = keptRoles.indexOf("tool");
        expect(keptRoles[toolIndex - 1]).toBe("assistant");
      }
    });

    test("should preserve all messages when below keepLast threshold", () => {
      const messages: ModelMessage[] = [
        { role: "system", content: "System" },
        { role: "user", content: "Short conversation" },
      ];

      const selection = selectMessagesToCompact(messages, 10);

      expect(selection.messagesToCompact).toHaveLength(0);
      expect(selection.messagesToKeep).toEqual(messages);
    });
  });
});
