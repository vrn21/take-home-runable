import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { formatToolResult, createTools, ExecResult } from "../../index";

// =============================================================================
// UNIT TESTS: TOOLS LAYER
// =============================================================================

describe("Tools Layer", () => {
  // =========================================================================
  // formatToolResult Tests
  // =========================================================================
  describe("formatToolResult", () => {
    it("should format stdout only result", () => {
      const result: ExecResult = {
        stdout: "Hello, World!",
        stderr: "",
        exitCode: 0,
      };
      const formatted = formatToolResult(result);
      expect(formatted).toBe("Hello, World!\n[exit code: 0]");
    });

    it("should format stderr only result", () => {
      const result: ExecResult = {
        stdout: "",
        stderr: "Error: file not found",
        exitCode: 1,
      };
      const formatted = formatToolResult(result);
      expect(formatted).toBe("[stderr]\nError: file not found\n[exit code: 1]");
    });

    it("should format combined stdout and stderr", () => {
      const result: ExecResult = {
        stdout: "Some output",
        stderr: "Some warning",
        exitCode: 0,
      };
      const formatted = formatToolResult(result);
      expect(formatted).toBe(
        "Some output\n[stderr]\nSome warning\n[exit code: 0]"
      );
    });

    it("should format empty output with exit code", () => {
      const result: ExecResult = {
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
      const formatted = formatToolResult(result);
      expect(formatted).toBe("\n[exit code: 0]");
    });

    it("should handle multiline output", () => {
      const result: ExecResult = {
        stdout: "line1\nline2\nline3",
        stderr: "",
        exitCode: 0,
      };
      const formatted = formatToolResult(result);
      expect(formatted).toBe("line1\nline2\nline3\n[exit code: 0]");
    });
  });

  // =========================================================================
  // createTools Tests
  // =========================================================================
  describe("createTools", () => {
    it("should create all four tools", () => {
      const tools = createTools("test-container-id");

      expect(tools).toHaveProperty("execute_command");
      expect(tools).toHaveProperty("read_file");
      expect(tools).toHaveProperty("write_file");
      expect(tools).toHaveProperty("list_directory");
    });

    it("should have correct descriptions", () => {
      const tools = createTools("test-container-id");

      expect(tools.execute_command.description).toContain("shell command");
      expect(tools.read_file.description).toContain("Read the contents");
      expect(tools.write_file.description).toContain("Write content");
      expect(tools.list_directory.description).toContain("List contents");
    });

    it("each tool should have an execute function", () => {
      const tools = createTools("test-container-id");

      expect(typeof tools.execute_command.execute).toBe("function");
      expect(typeof tools.read_file.execute).toBe("function");
      expect(typeof tools.write_file.execute).toBe("function");
      expect(typeof tools.list_directory.execute).toBe("function");
    });

    it("each tool should have inputSchema defined", () => {
      const tools = createTools("test-container-id");

      expect(tools.execute_command.inputSchema).toBeDefined();
      expect(tools.read_file.inputSchema).toBeDefined();
      expect(tools.write_file.inputSchema).toBeDefined();
      expect(tools.list_directory.inputSchema).toBeDefined();
    });
  });
});
