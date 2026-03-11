type LogLevel = "info" | "warn" | "error" | "debug";

interface LogEntry {
  level: LogLevel;
  who: string;
  what: string;
  when: string;
  result?: unknown;
  error?: unknown;
  duration?: number;
}

function format(entry: LogEntry): string {
  const parts = [
    `[${entry.when}]`,
    `[${entry.level.toUpperCase()}]`,
    `[${entry.who}]`,
    entry.what,
  ];
  if (entry.duration !== undefined) {
    parts.push(`(${entry.duration}ms)`);
  }
  if (entry.result !== undefined) {
    parts.push(`=> ${JSON.stringify(entry.result)}`);
  }
  if (entry.error !== undefined) {
    parts.push(
      `!! ${entry.error instanceof Error ? entry.error.message : JSON.stringify(entry.error)}`,
    );
  }
  return parts.join(" ");
}

function emit(
  level: LogLevel,
  who: string,
  what: string,
  extra?: Partial<LogEntry>,
) {
  const entry: LogEntry = {
    level,
    who,
    what,
    when: new Date().toISOString(),
    ...extra,
  };
  const line = format(entry);
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  info: (who: string, what: string, extra?: Partial<LogEntry>) =>
    emit("info", who, what, extra),
  warn: (who: string, what: string, extra?: Partial<LogEntry>) =>
    emit("warn", who, what, extra),
  error: (who: string, what: string, extra?: Partial<LogEntry>) =>
    emit("error", who, what, extra),
  debug: (who: string, what: string, extra?: Partial<LogEntry>) =>
    emit("debug", who, what, extra),
};
