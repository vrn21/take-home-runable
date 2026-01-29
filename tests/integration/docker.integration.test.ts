import { describe, test, expect, afterAll, beforeAll } from "bun:test";

import {
  startContainer,
  execInContainer,
  cleanupContainer,
  readFileInContainer,
  writeFileInContainer,
  listDirectoryInContainer,
  DockerError,
} from "../../index";

/**
 * These tests require Docker to be running.
 * The first test may take longer as it pulls the oven/bun:latest image.
 */
describe("Docker Integration Tests", () => {
  // Track containers for cleanup
  const containersToCleanup: string[] = [];

  afterAll(async () => {
    // Clean up any remaining containers
    for (const containerId of containersToCleanup) {
      try {
        await cleanupContainer(containerId);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe("Container Lifecycle", () => {
    test("startContainer should create and return container ID", async () => {
      const sessionId = `test-${Date.now()}`;
      const containerId = await startContainer(sessionId);

      expect(containerId).toBeDefined();
      expect(containerId.length).toBe(12);
      containersToCleanup.push(containerId);
    }, 120_000); // Allow 2 minutes for image pull

    test("cleanupContainer should stop and remove container", async () => {
      const sessionId = `test-cleanup-${Date.now()}`;
      const containerId = await startContainer(sessionId);

      // Verify container exists
      const checkProc = Bun.spawn(["docker", "inspect", containerId], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await checkProc.exited).toBe(0);

      // Cleanup
      await cleanupContainer(containerId);

      // Verify container is gone
      const checkProc2 = Bun.spawn(["docker", "inspect", containerId], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await checkProc2.exited).not.toBe(0);
    }, 30_000);

    test("cleanupContainer should handle non-existent container gracefully", async () => {
      // Should not throw
      await cleanupContainer("nonexistent-container-id");
    });
  });

  describe("Command Execution", () => {
    let containerId: string;

    beforeAll(async () => {
      const sessionId = `test-exec-${Date.now()}`;
      containerId = await startContainer(sessionId);
      containersToCleanup.push(containerId);
    }, 120_000);

    test("execInContainer should run simple command", async () => {
      const result = await execInContainer(containerId, "echo 'Hello, World!'");

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("Hello, World!");
      expect(result.stderr).toBe("");
    });

    test("execInContainer should capture stderr", async () => {
      const result = await execInContainer(
        containerId,
        "echo 'error' >&2 && exit 1"
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr.trim()).toBe("error");
    });

    test("execInContainer should handle complex commands", async () => {
      const result = await execInContainer(containerId, "pwd && whoami");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("/workspace");
    });

    test("execInContainer should timeout long-running commands", async () => {
      let error: DockerError | null = null;
      try {
        await execInContainer(containerId, "sleep 10", 500);
      } catch (e) {
        error = e as DockerError;
      }

      expect(error).not.toBeNull();
      expect(error!.code).toBe("COMMAND_TIMEOUT");
    }, 10_000);
  });

  describe("File Operations", () => {
    let containerId: string;

    beforeAll(async () => {
      const sessionId = `test-files-${Date.now()}`;
      containerId = await startContainer(sessionId);
      containersToCleanup.push(containerId);
    }, 120_000);

    test("writeFileInContainer should create file", async () => {
      const result = await writeFileInContainer(
        containerId,
        "test.txt",
        "Hello, World!"
      );

      expect(result.exitCode).toBe(0);
    });

    test("readFileInContainer should read file", async () => {
      await writeFileInContainer(containerId, "read-test.txt", "Test content");
      const result = await readFileInContainer(containerId, "read-test.txt");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Test content");
    });

    test("writeFileInContainer should handle content with special characters", async () => {
      const content = `const msg = "Hello's \\"world\\"!"\nconsole.log(msg);`;
      await writeFileInContainer(containerId, "special.ts", content);
      const result = await readFileInContainer(containerId, "special.ts");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(content);
    });

    test("writeFileInContainer should create nested directories", async () => {
      const result = await writeFileInContainer(
        containerId,
        "src/components/Button.tsx",
        "export const Button = () => <button/>"
      );

      expect(result.exitCode).toBe(0);

      const readResult = await readFileInContainer(
        containerId,
        "src/components/Button.tsx"
      );
      expect(readResult.exitCode).toBe(0);
    });

    test("listDirectoryInContainer should list files", async () => {
      await writeFileInContainer(containerId, "list-test/a.txt", "a");
      await writeFileInContainer(containerId, "list-test/b.txt", "b");

      const result = await listDirectoryInContainer(containerId, "list-test");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("a.txt");
      expect(result.stdout).toContain("b.txt");
    });

    test("readFileInContainer should return error for non-existent file", async () => {
      const result = await readFileInContainer(
        containerId,
        "nonexistent.txt"
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("No such file");
    });
  });
});
