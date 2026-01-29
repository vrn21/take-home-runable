import { describe, test, expect } from "bun:test";
import type { ModelMessage } from "ai";

import {
  estimateTokens,
  estimateMessagesTokens,
  calculateThreshold,
  shouldCompact,
  selectMessagesToCompact,
  formatMessagesForSummary,
  extractOriginalTask,
  DEFAULT_COMPACTION_CONFIG,
  type CompactionConfig,
} from "../../index";

describe("Context Compaction Unit Tests", () => {
  // ==========================================================================
  // Token Estimation Tests
  // ==========================================================================

  describe("estimateTokens", () => {
    test("should return 0 for empty string", () => {
      expect(estimateTokens("")).toBe(0);
    });

    test("should estimate ~4 characters per token", () => {
      // 20 characters = 5 tokens
      expect(estimateTokens("12345678901234567890")).toBe(5);
    });

    test("should round up for non-divisible lengths", () => {
      // 5 characters = ceil(5/4) = 2 tokens
      expect(estimateTokens("hello")).toBe(2);
    });

    test("should handle longer text", () => {
      const text = "a".repeat(1000);
      expect(estimateTokens(text)).toBe(250);
    });
  });

  describe("estimateMessagesTokens", () => {
    test("should return 0 for empty array", () => {
      expect(estimateMessagesTokens([])).toBe(0);
    });

    test("should count tokens for single user message", () => {
      const messages: ModelMessage[] = [
        { role: "user", content: "Hello world" }, // 11 chars = 3 tokens, + 2 for role = 5
      ];
      expect(estimateMessagesTokens(messages)).toBe(5);
    });

    test("should count tokens for multiple messages", () => {
      const messages: ModelMessage[] = [
        { role: "system", content: "You are helpful" }, // 15 chars = 4 tokens + 2 = 6
        { role: "user", content: "Hi" }, // 2 chars = 1 token + 2 = 3
        { role: "assistant", content: "Hello!" }, // 6 chars = 2 tokens + 2 = 4
      ];
      expect(estimateMessagesTokens(messages)).toBe(13);
    });

    test("should handle messages with array content", () => {
      const messages: ModelMessage[] = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me help" }, // 11 chars = 3 tokens
          ],
        },
      ];
      const result = estimateMessagesTokens(messages);
      expect(result).toBe(5); // 3 + 2 for role
    });
  });

  // ==========================================================================
  // Threshold Logic Tests
  // ==========================================================================

  describe("calculateThreshold", () => {
    test("should calculate threshold with default config", () => {
      // (128000 - 2000 - 4000 - 5000) * 0.80 = 93600
      const threshold = calculateThreshold(DEFAULT_COMPACTION_CONFIG);
      expect(threshold).toBe(93600);
    });

    test("should calculate threshold with custom config", () => {
      const config: CompactionConfig = {
        modelContextLimit: 8192,
        systemReserve: 500,
        outputReserve: 1000,
        safetyBuffer: 500,
        thresholdPercent: 0.75,
        recentMessagesToKeep: 5,
      };
      // (8192 - 500 - 1000 - 500) * 0.75 = 4644
      expect(calculateThreshold(config)).toBe(4644);
    });
  });

  describe("shouldCompact", () => {
    test("should return false for empty messages", () => {
      expect(shouldCompact([])).toBe(false);
    });

    test("should return false when messages count is minimal", () => {
      const messages: ModelMessage[] = Array(5).fill({ role: "user", content: "short" });
      expect(shouldCompact(messages)).toBe(false);
    });

    test("should return false when below threshold", () => {
      const messages: ModelMessage[] = [
        { role: "system", content: "System" },
        ...Array(20).fill({ role: "user", content: "Hello" }),
      ];
      expect(shouldCompact(messages)).toBe(false);
    });

    test("should return true when above threshold with custom low config", () => {
      const config: CompactionConfig = {
        modelContextLimit: 100,
        systemReserve: 10,
        outputReserve: 10,
        safetyBuffer: 10,
        thresholdPercent: 0.5,
        recentMessagesToKeep: 2,
      };
      // threshold = (100 - 10 - 10 - 10) * 0.5 = 35 tokens
      const messages: ModelMessage[] = Array(10).fill({
        role: "user",
        content: "a".repeat(20), // Each = 5 tokens + 2 role = 7 tokens
      });
      // 10 * 7 = 70 tokens > 35
      expect(shouldCompact(messages, config)).toBe(true);
    });
  });

  // ==========================================================================
  // Message Selection Tests
  // ==========================================================================

  describe("selectMessagesToCompact", () => {
    test("should return unchanged when too few messages", () => {
      const messages: ModelMessage[] = [
        { role: "system", content: "System prompt" },
        { role: "user", content: "Hello" },
      ];

      const result = selectMessagesToCompact(messages, 10);

      expect(result.messagesToCompact).toHaveLength(0);
      expect(result.messagesToKeep).toEqual(messages);
      expect(result.previousSummary).toBeNull();
    });

    test("should keep system message and last N messages", () => {
      const messages: ModelMessage[] = [
        { role: "system", content: "System" },
        { role: "user", content: "First" },
        { role: "assistant", content: "Second" },
        { role: "user", content: "Third" },
        { role: "assistant", content: "Fourth" },
        { role: "user", content: "Fifth" },
      ];

      const result = selectMessagesToCompact(messages, 2);

      expect(result.messagesToCompact).toHaveLength(3); // messages 1-3
      expect(result.messagesToKeep).toHaveLength(3); // system + last 2
      expect(result.messagesToKeep[0].content).toBe("System");
    });

    test("should not orphan tool results", () => {
      const messages: ModelMessage[] = [
        { role: "system", content: "System" },
        { role: "user", content: "Do something" },
        { role: "assistant", content: "I will call a tool" },
        { role: "tool", content: JSON.stringify({ toolCallId: "1", result: "done" }) },
        { role: "assistant", content: "Done" },
        { role: "user", content: "Thanks" },
      ];

      const result = selectMessagesToCompact(messages, 2);

      // Should not start keep section with tool message
      const firstKeptNonSystem = result.messagesToKeep[1];
      expect(firstKeptNonSystem?.role).not.toBe("tool");
    });

    test("should detect previous summary", () => {
      const messages: ModelMessage[] = [
        { role: "system", content: "System" },
        { role: "assistant", content: "## Session Summary (Round 1)\nPrevious work..." },
        { role: "user", content: "Continue" },
        { role: "assistant", content: "Continuing..." },
        ...Array(15).fill({ role: "user", content: "more" }),
      ];

      const result = selectMessagesToCompact(messages, 5);

      expect(result.previousSummary).toContain("## Session Summary");
    });
  });

  // ==========================================================================
  // Summary Formatting Tests
  // ==========================================================================

  describe("formatMessagesForSummary", () => {
    test("should format simple messages", () => {
      const messages: ModelMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ];

      const formatted = formatMessagesForSummary(messages);

      expect(formatted).toContain("[0] USER:");
      expect(formatted).toContain("Hello");
      expect(formatted).toContain("[1] ASSISTANT:");
      expect(formatted).toContain("Hi there");
    });

    test("should truncate very long content", () => {
      const messages: ModelMessage[] = [
        { role: "user", content: "a".repeat(3000) },
      ];

      const formatted = formatMessagesForSummary(messages);

      expect(formatted).toContain("[...truncated...]");
      expect(formatted.length).toBeLessThan(3000);
    });
  });

  describe("extractOriginalTask", () => {
    test("should extract first user message", () => {
      const messages: ModelMessage[] = [
        { role: "system", content: "System prompt" },
        { role: "user", content: "Build a flashcard app" },
        { role: "assistant", content: "I will help" },
      ];

      expect(extractOriginalTask(messages)).toBe("Build a flashcard app");
    });

    test("should return unknown for no user message", () => {
      const messages: ModelMessage[] = [
        { role: "system", content: "System" },
      ];

      expect(extractOriginalTask(messages)).toBe("Unknown task");
    });
  });
});
