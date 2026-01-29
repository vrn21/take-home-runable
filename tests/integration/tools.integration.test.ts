import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  createTools,
  startContainer,
  cleanupContainer,
} from "../../index";

// =============================================================================
// INTEGRATION TESTS: TOOLS LAYER
// =============================================================================

describe("Tools Integration", () => {
  let containerId: string;
  let tools: ReturnType<typeof createTools>;

  beforeAll(async () => {
    const sessionId = `test-tools-${Date.now()}`;
    containerId = await startContainer(sessionId);
    tools = createTools(containerId);
  });

  afterAll(async () => {
    await cleanupContainer(containerId);
  });

  // =========================================================================
  // execute_command Tests
  // =========================================================================
  describe("execute_command", () => {
    it("should execute a simple command", async () => {
      const result = await tools.execute_command.execute({ command: "echo 'Hello from container'" });
      expect(result).toContain("Hello from container");
      expect(result).toContain("[exit code: 0]");
    });

    it("should return stderr for failing commands", async () => {
      const result = await tools.execute_command.execute({ command: "ls /nonexistent-dir" });
      expect(result).toContain("[stderr]");
      expect(result).not.toContain("[exit code: 0]");
    });
  });

  // =========================================================================
  // write_file and read_file Tests
  // =========================================================================
  describe("file operations", () => {
    it("should write and read a file", async () => {
      const content = "Test content from tools integration";
      const writeResult = await tools.write_file.execute({
        path: "test-file.txt",
        content: content,
      });
      expect(writeResult).toBe("File written: test-file.txt");

      const readResult = await tools.read_file.execute({ path: "test-file.txt" });
      expect(readResult).toBe(content);
    });

    it("should create parent directories for nested files", async () => {
      const content = "Nested file content";
      const writeResult = await tools.write_file.execute({
        path: "deep/nested/dir/file.txt",
        content: content,
      });
      expect(writeResult).toBe("File written: deep/nested/dir/file.txt");

      const readResult = await tools.read_file.execute({
        path: "deep/nested/dir/file.txt",
      });
      expect(readResult).toBe(content);
    });

    it("should return error for non-existent file", async () => {
      const result = await tools.read_file.execute({ path: "does-not-exist.txt" });
      expect(result).toContain("Error reading file");
    });
  });

  // =========================================================================
  // list_directory Tests
  // =========================================================================
  describe("list_directory", () => {
    it("should list directory contents", async () => {
      // First create a file
      await tools.write_file.execute({
        path: "listable-file.txt",
        content: "test",
      });

      const result = await tools.list_directory.execute({ path: "." });
      expect(result).toContain("listable-file.txt");
    });

    it("should return error for non-existent directory", async () => {
      const result = await tools.list_directory.execute({
        path: "non-existent-directory",
      });
      expect(result).toContain("Error listing directory");
    });
  });
});
