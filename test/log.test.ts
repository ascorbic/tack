import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { log } from "../src/server/log.ts";

afterEach(() => vi.restoreAllMocks());

function captured(spy: { mock: { calls: unknown[][] } }) {
	return spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

describe("log", () => {
	it("writes one JSON line per event, with level, name and context", () => {
		const info = vi.spyOn(console, "log").mockImplementation(() => {});
		log.info("webhook.verified", { repo: "github.com/acme/widgets", cards: 2 });
		expect(captured(info)).toEqual([
			{ level: "info", event: "webhook.verified", repo: "github.com/acme/widgets", cards: 2 },
		]);
	});

	it("uses the console method that matches the level", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		log.warn("repo.fetch", { errors: 1 });
		log.error("webhook.failed");
		expect(captured(warn)[0]).toMatchObject({ level: "warn", event: "repo.fetch" });
		expect(captured(error)[0]).toMatchObject({ level: "error", event: "webhook.failed" });
	});

	it("serialises errors in context", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		log.error("board.save.failed", { error: new TypeError("nope") });
		const [entry] = captured(error);
		expect(entry?.error).toMatchObject({ name: "TypeError", message: "nope" });
		expect((entry?.error as { stack: string }).stack).toContain("TypeError: nope");
	});

	it("binds context with `with`", () => {
		const info = vi.spyOn(console, "log").mockImplementation(() => {});
		log.with({ forge: "github" }).info("webhook.received", { bytes: 10 });
		expect(captured(info)[0]).toEqual({
			level: "info",
			event: "webhook.received",
			forge: "github",
			bytes: 10,
		});
	});

	it("never throws on unserialisable context", () => {
		const info = vi.spyOn(console, "log").mockImplementation(() => {});
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => log.info("odd", { circular })).not.toThrow();
		expect(captured(info)[0]).toMatchObject({ event: "odd", unserialisable: true });
	});
});
