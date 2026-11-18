/**
 * Structured logging utility for ProjectPilot.
 * Provides consistent log format with context for debugging and audit trails.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  toolName?: string;
  projectId?: string;
  workspaceId?: string;
  error?: Error;
}

export interface ToolCallLog extends LogEntry {
  type: "tool_call";
  toolName: string;
  input?: unknown;
  output?: unknown;
  durationMs?: number;
  success: boolean;
  errorMessage?: string;
  message: string;
}

export interface ApprovalLog extends LogEntry {
  type: "approval";
  toolName: string;
  action: "requested" | "approved" | "rejected" | "completed" | "failed";
  approvalId?: string;
  projectId?: string;
}

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const envLogLevel = typeof process !== "undefined" ? process.env?.LOG_LEVEL : undefined;
const CURRENT_LEVEL: LogLevel = (envLogLevel as LogLevel) ?? "info";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[CURRENT_LEVEL];
}

function formatEntry(entry: LogEntry): string {
  const base = {
    timestamp: entry.timestamp,
    level: entry.level.toUpperCase(),
    message: entry.message,
    ...(entry.context && { context: entry.context }),
    ...(entry.toolName && { tool: entry.toolName }),
    ...(entry.projectId && { projectId: entry.projectId }),
    ...(entry.workspaceId && { workspaceId: entry.workspaceId }),
    ...(entry.error && { error: { message: entry.error.message, stack: entry.error.stack } })
  };
  return JSON.stringify(base);
}

function formatToolCall(entry: ToolCallLog): string {
  return JSON.stringify({
    timestamp: entry.timestamp,
    level: entry.level.toUpperCase(),
    type: "tool_call",
    tool: entry.toolName,
    success: entry.success,
    durationMs: entry.durationMs,
    ...(entry.input !== undefined && { input: entry.input }),
    ...(entry.output !== undefined && { output: entry.output }),
    ...(entry.errorMessage && { error: entry.errorMessage }),
    ...(entry.projectId && { projectId: entry.projectId }),
    ...(entry.workspaceId && { workspaceId: entry.workspaceId })
  });
}

function formatApproval(entry: ApprovalLog): string {
  return JSON.stringify({
    timestamp: entry.timestamp,
    level: entry.level.toUpperCase(),
    type: "approval",
    tool: entry.toolName,
    action: entry.action,
    ...(entry.approvalId && { approvalId: entry.approvalId }),
    ...(entry.projectId && { projectId: entry.projectId }),
    ...(entry.workspaceId && { workspaceId: entry.workspaceId }),
    ...(entry.message && { message: entry.message })
  });
}

function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const entry: LogEntry = { timestamp: new Date().toISOString(), level, message, context };
  console[level === "debug" ? "log" : level](formatEntry(entry));
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => log("debug", message, context),
  info: (message: string, context?: Record<string, unknown>) => log("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => log("warn", message, context),
  error: (message: string, error?: Error, context?: Record<string, unknown>) => {
    if (!shouldLog("error")) return;
    const entry: LogEntry = { timestamp: new Date().toISOString(), level: "error", message, context, error };
    console.error(formatEntry(entry));
  },

  toolCall: (params: Omit<ToolCallLog, "timestamp" | "level" | "type">) => {
    if (!shouldLog("info")) return;
    const entry: ToolCallLog = { ...params, timestamp: new Date().toISOString(), level: params.success ? "info" : "error", type: "tool_call" };
    console[params.success ? "log" : "error"](formatToolCall(entry));
  },

  approval: (params: Omit<ApprovalLog, "timestamp" | "level" | "type">) => {
    if (!shouldLog("info")) return;
    const entry: ApprovalLog = { ...params, timestamp: new Date().toISOString(), level: "info", type: "approval" };
    console.log(formatApproval(entry));
  },

  // Helper to wrap tool execution with timing and logging
  withToolLogging: async <T>(
    toolName: string,
    execute: () => Promise<T>,
    context?: { projectId?: string; workspaceId?: string; input?: unknown }
  ): Promise<T> => {
    const start = performance.now();
    logger.debug(`Tool execution started`, { toolName, ...context });
    try {
      const result = await execute();
      const durationMs = Math.round(performance.now() - start);
      logger.toolCall({ toolName, success: true, durationMs, input: context?.input, output: result, projectId: context?.projectId, workspaceId: context?.workspaceId, message: `${toolName} succeeded` });
      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.toolCall({ toolName, success: false, durationMs, input: context?.input, errorMessage, projectId: context?.projectId, workspaceId: context?.workspaceId, message: `${toolName} failed: ${errorMessage}` });
      logger.error(`Tool execution failed`, error instanceof Error ? error : new Error(errorMessage), { toolName, ...context });
      throw error;
    }
  }
};

/**
 * Creates a scoped logger with default context (e.g., workspaceId).
 */
export function createScopedLogger(defaultContext: Record<string, unknown>) {
  return {
    debug: (message: string, context?: Record<string, unknown>) => logger.debug(message, { ...defaultContext, ...context }),
    info: (message: string, context?: Record<string, unknown>) => logger.info(message, { ...defaultContext, ...context }),
    warn: (message: string, context?: Record<string, unknown>) => logger.warn(message, { ...defaultContext, ...context }),
    error: (message: string, error?: Error, context?: Record<string, unknown>) => logger.error(message, error, { ...defaultContext, ...context }),
    toolCall: (params: Omit<ToolCallLog, "timestamp" | "level" | "type">) => logger.toolCall({ ...params, ...defaultContext }),
    approval: (params: Omit<ApprovalLog, "timestamp" | "level" | "type">) => logger.approval({ ...params, ...defaultContext }),
    withToolLogging: <T>(toolName: string, execute: () => Promise<T>, extraContext?: Record<string, unknown>) =>
      logger.withToolLogging(toolName, execute, { ...defaultContext, ...extraContext })
  };
}