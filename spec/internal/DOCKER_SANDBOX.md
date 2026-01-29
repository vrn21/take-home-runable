# Docker Sandbox Layer - Internal Design

## Overview

The Docker Sandbox Layer provides isolated execution environments for code generation tasks. All shell commands, file operations, and code execution run inside ephemeral Docker containers.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                       Docker Sandbox Layer                               │
├──────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐       │
│  │ startContainer  │───▶│ execInContainer │───▶│cleanupContainer │       │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘       │
│           │                     │                      │                 │
│           ▼                     ▼                      ▼                 │
│       docker run            docker exec         docker stop/rm           │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Configuration

```typescript
interface DockerConfig {
  image: string;            // Docker image to use
  containerPrefix: string;  // Prefix for container names
  workdir: string;          // Working directory inside container
  commandTimeoutMs: number; // Timeout for exec commands
}

const DOCKER_CONFIG: DockerConfig = {
  image: 'oven/bun:latest',
  containerPrefix: 'coding-agent-',
  workdir: '/workspace',
  commandTimeoutMs: 60_000,
};
```

---

## Start Container

```typescript
import { spawn } from 'bun';

async function startContainer(sessionId: string): Promise<string> {
  const containerName = `${DOCKER_CONFIG.containerPrefix}${sessionId}`;
  
  const args = [
    'run', '-d',
    '--name', containerName,
    '-w', DOCKER_CONFIG.workdir,
    DOCKER_CONFIG.image,
    'tail', '-f', '/dev/null',
  ];
  
  console.log(`[Docker] Starting container: ${containerName}`);
  
  const proc = spawn(['docker', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  
  if (exitCode !== 0) {
    throw new DockerError(`Failed to start container: ${stderr.trim()}`, 'CONTAINER_START_FAILED');
  }
  
  return stdout.trim().slice(0, 12);
}
```

---

## Execute in Container

```typescript
interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function execInContainer(
  containerId: string,
  command: string,
  timeoutMs: number = DOCKER_CONFIG.commandTimeoutMs
): Promise<ExecResult> {
  const proc = spawn(['docker', 'exec', containerId, 'sh', '-c', command], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  
  const timeoutId = setTimeout(() => proc.kill(), timeoutMs);
  
  try {
    const exitCode = await proc.exited;
    clearTimeout(timeoutId);
    
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    
    return {
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(stderr),
      exitCode,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    throw new DockerError(`Command failed: ${error}`, 'EXEC_FAILED');
  }
}

function truncateOutput(output: string, maxLength: number = 10_000): string {
  if (output.length <= maxLength) return output;
  return `${output.slice(0, maxLength)}\n[...truncated at ${maxLength} chars...]`;
}
```

---

## File Operations

```typescript
function resolvePath(path: string): string {
  const cleanPath = path.replace(/^\/+/, '');
  return `${DOCKER_CONFIG.workdir}/${cleanPath}`;
}

async function readFileInContainer(containerId: string, path: string): Promise<ExecResult> {
  return execInContainer(containerId, `cat "${resolvePath(path)}"`);
}

async function writeFileInContainer(containerId: string, path: string, content: string): Promise<ExecResult> {
  const fullPath = resolvePath(path);
  
  // Use base64 encoding to safely transfer content without shell escaping issues
  const base64Content = Buffer.from(content).toString('base64');
  
  const command = `mkdir -p "$(dirname "${fullPath}")" && echo "${base64Content}" | base64 -d > "${fullPath}"`;
  return execInContainer(containerId, command);
}

async function listDirectoryInContainer(containerId: string, path: string): Promise<ExecResult> {
  return execInContainer(containerId, `ls -la "${resolvePath(path || '.')}"`);
}
```

---

## Cleanup Container

```typescript
async function cleanupContainer(containerId: string): Promise<void> {
  if (!containerId) return;
  
  console.log(`[Docker] Cleaning up: ${containerId}`);
  
  try {
    await spawn(['docker', 'stop', '-t', '10', containerId]).exited;
    await spawn(['docker', 'rm', '-f', containerId]).exited;
  } catch (error) {
    console.error(`[Docker] Cleanup failed: ${error}`);
  }
}
```

---

## Error Handling

```typescript
type DockerErrorCode = 'CONTAINER_START_FAILED' | 'EXEC_FAILED' | 'COMMAND_TIMEOUT';

class DockerError extends Error {
  code: DockerErrorCode;
  constructor(message: string, code: DockerErrorCode) {
    super(message);
    this.name = 'DockerError';
    this.code = code;
  }
}
```

| Error Type | Handling | Recoverable |
|------------|----------|-------------|
| Container start fails | Fail session | No |
| Command exec fails | Return error to LLM | Yes |
| Command timeout | Kill process, return error | Yes |
| Cleanup fails | Log warning | Yes |

---

## Integration Pattern

```typescript
async function runSession(task: string) {
  const session = await createSession(task);
  let containerId: string | null = null;
  
  try {
    containerId = await startContainer(session.id);
    const result = await runAgent(session.id, task, containerId);
    await updateSessionStatus(session.id, 'completed');
    return result;
  } catch (error) {
    await updateSessionStatus(session.id, 'failed');
    throw error;
  } finally {
    if (containerId) await cleanupContainer(containerId);
  }
}
```

---

## File Location

Implement in `index.ts` within **SECTION 5: DOCKER FUNCTIONS**.
