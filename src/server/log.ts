// Structured logs: one JSON object per line, with an event name and context.
// Workers Logs (enabled under `observability` in cloudflare.config.ts) parses
// JSON lines and indexes their fields, so events can be filtered by name and
// by any context key, e.g. `event = "webhook.failed"` or `repo = "…"`.

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

export type LogFn = (event: string, context?: LogContext) => void;

export interface Logger {
	debug: LogFn;
	info: LogFn;
	warn: LogFn;
	error: LogFn;
	/** A logger that adds `context` to every event, e.g. `{ board: name }`. */
	with: (context: LogContext) => Logger;
}

// Workers Logs sets the level from the console method used.
const WRITERS: Record<LogLevel, (line: string) => void> = {
	debug: (line) => console.debug(line),
	info: (line) => console.log(line),
	warn: (line) => console.warn(line),
	error: (line) => console.error(line),
};

const MAX_STACK = 4000;

/** A plain, JSON-safe description of a thrown value. */
export function describeError(error: unknown): LogContext {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			...(error.stack ? { stack: error.stack.slice(0, MAX_STACK) } : {}),
		};
	}
	return { message: String(error) };
}

function serialise(entry: LogContext): string {
	try {
		return JSON.stringify(entry, (key, value: unknown) => {
			if (value instanceof Error) return describeError(value);
			if (typeof value === "bigint") return value.toString();
			return value;
		});
	} catch {
		// Circular or otherwise unserialisable context: keep the event, at least.
		return JSON.stringify({ level: entry.level, event: entry.event, unserialisable: true });
	}
}

function createLogger(base: LogContext): Logger {
	const write = (level: LogLevel, event: string, context?: LogContext) => {
		WRITERS[level](serialise({ level, event, ...base, ...context }));
	};
	return {
		debug: (event, context) => write("debug", event, context),
		info: (event, context) => write("info", event, context),
		warn: (event, context) => write("warn", event, context),
		error: (event, context) => write("error", event, context),
		with: (context) => createLogger({ ...base, ...context }),
	};
}

export const log: Logger = createLogger({});
