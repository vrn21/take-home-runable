# Interstice

A coding agent that handles long-running tasks by executing commands in a Docker sandbox and automatically compacting its context window using summarization.

## Key Features

- **Sandboxed Execution**: All commands run safely inside a dedicated Docker container.
- **Context Compaction**: Automatically summarizes session history when approaching token limits (~80%), ensuring the agent never runs out of context.
- **Persistence**: Usage history (sessions, messages, compaction events) is saved to a local SQLite database (`agent.db`).
- **Robustness**: Handles AI SDK v6 message formats, including complex tool calls and results.

## Requirements

- [Bun](https://bun.sh)
- [Docker](https://www.docker.com/) (must be running)
- An LLM API Key (Anthropic or OpenAI)

## Quick Start

1.  **Install Dependencies**:
    ```bash
    bun install
    ```

2.  **Set API Key**:
    ```bash
    export ANTHROPIC_API_KEY=sk-...
    # OR
    export OPENAI_API_KEY=sk-...
    ```

3.  **Run the Agent**:
    ```bash
    bun run index.ts
    ```

4.  **Enter Task**:
    Type your request (e.g., "Create a snake game in python") and press **Enter twice**.

## Project Structure

The entire implementation resides in a single file for portability:
*   `index.ts`: Core logic (Agent Loop, Database Schema, Docker Management, Context Compaction).

## Testing

Run the test suite to verify components:
```bash
# Run unit tests (logic & persistence)
bun test tests/unit

# Run integration tests (docker & compaction flow)
bun test tests/integration
```
