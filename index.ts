import { generateText, tool } from "ai";
import { z } from "zod";

// import { drizzle } from "drizzle-orm/bun-sqlite";
// import { Database } from "bun:sqlite";

// =============================================================================
// TODO: Choose your LLM provider and configure it
// =============================================================================
// Example with OpenAI:
// import { openai } from "@ai-sdk/openai";
// const model = openai("gpt-4o");
//
// Example with Anthropic:
// import { anthropic } from "@ai-sdk/anthropic";
// const model = anthropic("claude-sonnet-4-20250514");

// =============================================================================
// TODO: Define your Drizzle schema for sessions, messages, and compactions
// =============================================================================
// Example schema structure:
// const sessions = sqliteTable("sessions", { ... });
// const messages = sqliteTable("messages", { ... });

// =============================================================================
// TODO: Initialize database connection
// =============================================================================
// const sqlite = new Database("agent.db");
// const db = drizzle(sqlite);

// =============================================================================
// TODO: Implement Docker container management
// =============================================================================
// - Start a container for the session
// - Execute commands inside the container
// - Clean up container when done

// =============================================================================
// TODO: Implement token estimation
// =============================================================================
// Simple heuristic: ~4 characters per token
const estimateTokens = (text: string): number => {
  // TODO: Implement
  return 0;
};

// =============================================================================
// TODO: Implement context compaction
// =============================================================================
// - Track total tokens used
// - When approaching limit, summarize old messages

// =============================================================================
// TODO: Define your agent tools
// =============================================================================
const tools = {
  // runCommand: tool({ ... }),
  // readFile: tool({ ... }),
  // writeFile: tool({ ... }),
  // listFiles: tool({ ... }),
};

// =============================================================================
// TODO: Implement the main agent loop with context compaction
// =============================================================================
// Use generateText with prepareStep to handle compaction, or use ToolLoopAgent

const main = async () => {
  // TODO: Implement
  // 1. Create or resume a session
  // 2. Start Docker container
  // 3. Run agent loop with compaction
  // 4. Persist messages
  // 5. Clean up

  console.log("Agent not implemented yet");
};

main().catch(console.error);
