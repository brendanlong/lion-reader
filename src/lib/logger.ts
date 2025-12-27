/**
 * Structured Logger
 *
 * Provides a consistent logging interface that outputs structured JSON in production
 * and human-readable logs in development.
 *
 * Usage:
 * ```typescript
 * import { logger } from "@/lib/logger";
 *
 * logger.info("User logged in", { userId: "123", email: "user@example.com" });
 * logger.error("Failed to fetch feed", { feedId: "456", error: error.message });
 * ```
 */

import * as Sentry from "@sentry/nextjs";

/**
 * Log levels in order of severity.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Context data that can be attached to log entries.
 */
export type LogContext = Record<string, unknown>;

/**
 * A structured log entry.
 */
interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
}

/**
 * Logger configuration options.
 */
interface LoggerConfig {
  /** Minimum log level to output (default: "info" in production, "debug" in development) */
  minLevel?: LogLevel;
  /** Whether to output JSON format (default: true in production, false in development) */
  json?: boolean;
  /** Service name for structured logs */
  service?: string;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const isProduction = process.env.NODE_ENV === "production";

/**
 * Creates a logger instance with the given configuration.
 */
function createLogger(config: LoggerConfig = {}) {
  const {
    minLevel = isProduction ? "info" : "debug",
    json = isProduction,
    service = "lion-reader",
  } = config;

  const minLevelPriority = LOG_LEVEL_PRIORITY[minLevel];

  /**
   * Formats a log entry for output.
   */
  function formatEntry(entry: LogEntry): string {
    if (json) {
      return JSON.stringify({
        ...entry,
        service,
        ...(entry.context && { ...entry.context }),
      });
    }

    // Human-readable format for development
    const levelColors: Record<LogLevel, string> = {
      debug: "\x1b[36m", // cyan
      info: "\x1b[32m", // green
      warn: "\x1b[33m", // yellow
      error: "\x1b[31m", // red
    };
    const reset = "\x1b[0m";
    const levelColor = levelColors[entry.level];
    const levelStr = `[${entry.level.toUpperCase()}]`.padEnd(7);

    let output = `${levelColor}${levelStr}${reset} ${entry.message}`;

    if (entry.context && Object.keys(entry.context).length > 0) {
      output += ` ${JSON.stringify(entry.context)}`;
    }

    return output;
  }

  /**
   * Logs a message at the given level.
   */
  function log(level: LogLevel, message: string, context?: LogContext): void {
    if (LOG_LEVEL_PRIORITY[level] < minLevelPriority) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
    };

    const formatted = formatEntry(entry);

    switch (level) {
      case "debug":
      case "info":
        console.log(formatted);
        break;
      case "warn":
        console.warn(formatted);
        break;
      case "error":
        console.error(formatted);
        // Also report errors to Sentry
        if (isProduction) {
          Sentry.addBreadcrumb({
            category: "log",
            message,
            level: "error",
            data: context,
          });
        }
        break;
    }
  }

  return {
    /**
     * Logs a debug message (only shown in development by default).
     */
    debug: (message: string, context?: LogContext) => log("debug", message, context),

    /**
     * Logs an info message.
     */
    info: (message: string, context?: LogContext) => log("info", message, context),

    /**
     * Logs a warning message.
     */
    warn: (message: string, context?: LogContext) => log("warn", message, context),

    /**
     * Logs an error message and reports to Sentry in production.
     */
    error: (message: string, context?: LogContext) => log("error", message, context),

    /**
     * Creates a child logger with additional context.
     * Useful for adding request-specific context.
     */
    child: (additionalContext: LogContext) => {
      return {
        debug: (message: string, context?: LogContext) =>
          log("debug", message, { ...additionalContext, ...context }),
        info: (message: string, context?: LogContext) =>
          log("info", message, { ...additionalContext, ...context }),
        warn: (message: string, context?: LogContext) =>
          log("warn", message, { ...additionalContext, ...context }),
        error: (message: string, context?: LogContext) =>
          log("error", message, { ...additionalContext, ...context }),
      };
    },
  };
}

/**
 * Default logger instance.
 */
export const logger = createLogger();

/**
 * Creates a request-scoped logger with request context.
 */
export function createRequestLogger(context: {
  requestId?: string;
  userId?: string;
  path?: string;
  method?: string;
}) {
  return logger.child(context);
}

/**
 * Creates a job-scoped logger with job context.
 */
export function createJobLogger(context: { jobId: string; jobType: string; attempt?: number }) {
  return logger.child(context);
}

export { createLogger };
