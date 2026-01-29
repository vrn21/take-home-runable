import { describe, test, expect } from "bun:test";

import {
  DockerError,
  truncateOutput,
  resolvePath,
  DOCKER_CONFIG,
} from "../../index";

describe("Docker Unit Tests", () => {
  describe("DockerError", () => {
    test("should create error with message and code", () => {
      const error = new DockerError("Container failed", "CONTAINER_START_FAILED");

      expect(error.message).toBe("Container failed");
      expect(error.code).toBe("CONTAINER_START_FAILED");
      expect(error.name).toBe("DockerError");
    });

    test("should be instanceof Error", () => {
      const error = new DockerError("Test error", "EXEC_FAILED");
      expect(error instanceof Error).toBe(true);
      expect(error instanceof DockerError).toBe(true);
    });

    test("should support all error codes", () => {
      const codes = ["CONTAINER_START_FAILED", "EXEC_FAILED", "COMMAND_TIMEOUT"] as const;

      for (const code of codes) {
        const error = new DockerError(`Error: ${code}`, code);
        expect(error.code).toBe(code);
      }
    });
  });

  describe("truncateOutput", () => {
    test("should return unchanged output when below max length", () => {
      const output = "Hello, world!";
      expect(truncateOutput(output)).toBe(output);
    });

    test("should truncate output when above max length", () => {
      const output = "a".repeat(15_000);
      const truncated = truncateOutput(output);

      expect(truncated.length).toBeLessThan(output.length);
      expect(truncated).toContain("[...truncated at 10000 chars...]");
      expect(truncated.startsWith("a".repeat(10_000))).toBe(true);
    });

    test("should respect custom max length", () => {
      const output = "a".repeat(100);
      const truncated = truncateOutput(output, 50);

      expect(truncated).toContain("[...truncated at 50 chars...]");
      expect(truncated.startsWith("a".repeat(50))).toBe(true);
    });

    test("should handle empty string", () => {
      expect(truncateOutput("")).toBe("");
    });

    test("should handle exact max length", () => {
      const output = "a".repeat(100);
      expect(truncateOutput(output, 100)).toBe(output);
    });
  });

  describe("resolvePath", () => {
    test("should prefix path with workspace directory", () => {
      expect(resolvePath("src/index.ts")).toBe("/workspace/src/index.ts");
    });

    test("should strip leading slashes", () => {
      expect(resolvePath("/src/index.ts")).toBe("/workspace/src/index.ts");
      expect(resolvePath("///src/index.ts")).toBe("/workspace/src/index.ts");
    });

    test("should handle empty path", () => {
      expect(resolvePath("")).toBe("/workspace/");
    });

    test("should handle nested paths", () => {
      expect(resolvePath("src/components/Button.tsx")).toBe(
        "/workspace/src/components/Button.tsx"
      );
    });

    test("should use DOCKER_CONFIG workdir", () => {
      const result = resolvePath("test.ts");
      expect(result.startsWith(DOCKER_CONFIG.workdir)).toBe(true);
    });
  });

  describe("DOCKER_CONFIG", () => {
    test("should have expected default values", () => {
      expect(DOCKER_CONFIG.image).toBe("oven/bun:latest");
      expect(DOCKER_CONFIG.containerPrefix).toBe("coding-agent-");
      expect(DOCKER_CONFIG.workdir).toBe("/workspace");
      expect(DOCKER_CONFIG.commandTimeoutMs).toBe(60_000);
    });
  });
});
