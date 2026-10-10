import { useSyncExternalStore } from "react";
import { BUILT_IN_TEMPLATES, builtInInfo } from "../../shared/builtInTemplates.ts";
import type { SaveTemplateRequest, TemplateInfo, TemplateList } from "../../shared/templates.ts";
import { type ApiResult, call, send } from "./api.ts";

// Templates on the client (#53): the built-ins, sketched here from their
// content (no request needed), and the ones saved on this instance, from
// `GET /api/templates`, fetched once when the home page loads so the "New
// board" picker opens with them already there.

/** The built-in templates, as the picker shows them. */
export const BUILT_IN_INFOS: readonly TemplateInfo[] = BUILT_IN_TEMPLATES.map(builtInInfo);

export const templatesApi = {
	list: () => call<TemplateList>("/api/templates"),
	save: (request: SaveTemplateRequest) =>
		call<TemplateInfo>("/api/templates", send("POST", request)),
	remove: (id: string) =>
		call<{ deleted: true }>(`/api/templates/${encodeURIComponent(id)}`, send("DELETE")),
};

export type SavedTemplates =
	| { status: "loading" }
	| { status: "ready"; templates: TemplateInfo[] }
	| { status: "failed" };

/** Saved templates, shared by the picker and whatever saves or deletes one. */
class TemplateLibrary {
	private state: SavedTemplates = { status: "loading" };
	private loading: Promise<void> | null = null;
	private listeners = new Set<() => void>();
	/** Where they come from; the gallery swaps in its own. */
	source: () => Promise<ApiResult<TemplateList>> = templatesApi.list;

	get = (): SavedTemplates => this.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private update(state: SavedTemplates): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}

	/** Fetch them, unless that's under way (or done, unless `force`). */
	load(force = false): Promise<void> {
		if (this.loading && !force) return this.loading;
		const loading = this.source().then((result) => {
			if (this.loading !== loading) return;
			this.update(
				result.ok ? { status: "ready", templates: result.value.templates } : { status: "failed" },
			);
		});
		this.loading = loading;
		return loading;
	}

	/** One was saved: show it first straight away. */
	added(template: TemplateInfo): void {
		const current = this.state.status === "ready" ? this.state.templates : [];
		this.update({
			status: "ready",
			templates: [template, ...current.filter((t) => t.id !== template.id)],
		});
	}

	/** One was deleted. */
	removed(id: string): void {
		if (this.state.status !== "ready") return;
		this.update({ status: "ready", templates: this.state.templates.filter((t) => t.id !== id) });
	}

	/** For the gallery: show exactly this. */
	show(state: SavedTemplates): void {
		this.loading = Promise.resolve();
		this.update(state);
	}
}

export const templateLibrary = new TemplateLibrary();

export function useSavedTemplates(): SavedTemplates {
	return useSyncExternalStore(templateLibrary.subscribe, templateLibrary.get);
}

/** A board's name to start with: the template's, and today, e.g. "Retro · 10 Oct". */
export function suggestedTitle(template: TemplateInfo | null, now = Date.now()): string {
	if (!template) return "";
	const day = new Date(now).toLocaleDateString(undefined, { day: "numeric", month: "short" });
	return `${template.title} · ${day}`;
}
