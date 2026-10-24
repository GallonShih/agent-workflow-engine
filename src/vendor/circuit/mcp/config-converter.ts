// Shim：Circuit 的 MCP 設定轉換器只需要型別，直接沿用 SDK 的 McpServerConfig。
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
export type SDKMCPServersConfig = Record<string, McpServerConfig>;
