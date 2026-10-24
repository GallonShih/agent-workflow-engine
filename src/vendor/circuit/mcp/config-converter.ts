// Replaces smogili1/circuit backend/src/mcp/config-converter.ts (Apache-2.0, see ../LICENSE, ../UPSTREAM_COMMIT) with a type-only shim.
// Shim：Circuit 的 MCP 設定轉換器只需要型別，直接沿用 SDK 的 McpServerConfig。
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
export type SDKMCPServersConfig = Record<string, McpServerConfig>;
