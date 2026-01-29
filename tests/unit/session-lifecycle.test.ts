import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";

import { validateEnvironment, getModel } from "../../index";

describe("Session Lifecycle Unit Tests", () => {
  describe("validateEnvironment", () => {
    let originalEnv: Record<string, string | undefined>;
    let exitMock: ReturnType<typeof spyOn>;
    let errorMock: ReturnType<typeof spyOn>;

    beforeEach(() => {
      originalEnv = {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      };
      exitMock = spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit");
      });
      errorMock = spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      process.env.ANTHROPIC_API_KEY = originalEnv.ANTHROPIC_API_KEY;
      process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY;
      exitMock.mockRestore();
      errorMock.mockRestore();
    });

    test("should not exit when ANTHROPIC_API_KEY is set", () => {
      process.env.ANTHROPIC_API_KEY = "test-key";
      delete process.env.OPENAI_API_KEY;
      expect(() => validateEnvironment()).not.toThrow();
    });

    test("should not exit when OPENAI_API_KEY is set", () => {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      expect(() => validateEnvironment()).not.toThrow();
    });

    test("should not exit when both API keys are set", () => {
      process.env.ANTHROPIC_API_KEY = "anthropic-key";
      process.env.OPENAI_API_KEY = "openai-key";
      expect(() => validateEnvironment()).not.toThrow();
    });

    test("should exit when no API key is set", () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      expect(() => validateEnvironment()).toThrow("exit");
      expect(exitMock).toHaveBeenCalledWith(1);
    });
  });

  describe("getModel", () => {
    let originalEnv: Record<string, string | undefined>;

    beforeEach(() => {
      originalEnv = {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        MODEL: process.env.MODEL,
      };
    });

    afterEach(() => {
      process.env.ANTHROPIC_API_KEY = originalEnv.ANTHROPIC_API_KEY;
      process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY;
      process.env.MODEL = originalEnv.MODEL;
    });

    test("should throw error when no API key is set", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      await expect(getModel()).rejects.toThrow("No API key found");
    });

    // Note: Can't fully test model creation without mocking the AI SDK imports
    // These tests verify the error case which doesn't require the SDK
  });
});
