# Tools Layer - Internal Design

## Overview

The Tools Layer defines the four agent tools that enable code generation: execute_command, read_file, write_file, and list_directory. All tools execute inside the Docker container.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Tools Layer                                    │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐          │
│  │execute_command  │  │   read_file     │  │   write_file    │          │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘          │
│           │                    │                    │                    │
│           └────────────────────┼────────────────────┘                    │
│                                ▼                                         │
│                    ┌─────────────────────┐                              │
│                    │   Docker Sandbox    │                              │
│                    │   (execInContainer) │                              │
│                    └─────────────────────┘                              │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Tool Definitions

```typescript
import { tool } from 'ai';
import { z } from 'zod';

function createTools(containerId: string) {
  return {
    execute_command: tool({
      description: 'Execute a shell command in the container. Use for running bun, npm, git, or any shell command.',
      parameters: z.object({
        command: z.string().describe('The command to execute'),
      }),
      execute: async ({ command }) => {
        const result = await execInContainer(containerId, command);
        return formatToolResult(result);
      },
    }),

    read_file: tool({
      description: 'Read the contents of a file. Path is relative to /workspace.',
      parameters: z.object({
        path: z.string().describe('Path to the file (relative to /workspace)'),
      }),
      execute: async ({ path }) => {
        const result = await readFileInContainer(containerId, path);
        if (result.exitCode !== 0) {
          return `Error reading file: ${result.stderr || 'File not found'}`;
        }
        return result.stdout;
      },
    }),

    write_file: tool({
      description: 'Write content to a file. Creates parent directories if needed. Path is relative to /workspace.',
      parameters: z.object({
        path: z.string().describe('Path to the file (relative to /workspace)'),
        content: z.string().describe('Content to write to the file'),
      }),
      execute: async ({ path, content }) => {
        const result = await writeFileInContainer(containerId, path, content);
        if (result.exitCode !== 0) {
          return `Error writing file: ${result.stderr}`;
        }
        return `File written: ${path}`;
      },
    }),

    list_directory: tool({
      description: 'List contents of a directory. Path is relative to /workspace.',
      parameters: z.object({
        path: z.string().describe('Path to the directory (relative to /workspace)').default('.'),
      }),
      execute: async ({ path }) => {
        const result = await listDirectoryInContainer(containerId, path);
        if (result.exitCode !== 0) {
          return `Error listing directory: ${result.stderr}`;
        }
        return result.stdout;
      },
    }),
  };
}
```

---

## Tool Result Formatting

```typescript
function formatToolResult(result: ExecResult): string {
  let output = '';
  
  if (result.stdout) {
    output += result.stdout;
  }
  
  if (result.stderr) {
    output += output ? '\n' : '';
    output += `[stderr]\n${result.stderr}`;
  }
  
  output += `\n[exit code: ${result.exitCode}]`;
  
  return output;
}
```

---

## Parameter Schemas

| Tool | Parameter | Type | Description |
|------|-----------|------|-------------|
| execute_command | command | string | Shell command to run |
| read_file | path | string | Relative path to file |
| write_file | path | string | Relative path to file |
| write_file | content | string | File content |
| list_directory | path | string | Relative path to dir (default: ".") |

---

## Example Tool Usage

```
// LLM generates tool call:
{
  "name": "execute_command",
  "arguments": { "command": "bun init -y" }
}

// Tool executes and returns:
"✓ Created package.json

[exit code: 0]"
```

---

## Error Handling

All tool errors are returned as string results to let the LLM decide how to proceed:

```typescript
execute: async ({ command }) => {
  try {
    const result = await execInContainer(containerId, command);
    return formatToolResult(result);
  } catch (error) {
    return `[Error] ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
},
```

---

## File Location

Implement in `index.ts` within **SECTION 7: TOOLS**.
