import type * as Y from "yjs";
import { CUSTOM_EXAMPLES, exampleConfig } from "../../shared/customWidgetExamples.ts";
import type { CustomConfig } from "../../shared/customWidgets.ts";
import { shapesMap } from "../../shared/shapes.ts";
import { addWidget } from "../../shared/widgetRegistry.ts";
import { cardStore } from "../cardStore.ts";
import { MILESTONE } from "./kindFixtures.ts";
import { SANDBOX_CHECK } from "./sandboxCheck.ts";
import { REPO, searchableCards } from "./widgets.ts";

// Custom widgets in the playground (#66): the examples over the fake
// repository, a widget that tries every way out of its sandbox and shows
// each one closed, and an empty one to start from.

/** Custom widgets over the fake repository. */
export function seedCustom(doc: Y.Doc): void {
	for (const card of searchableCards()) cardStore.set(card);
	const place = (x: number, y: number, w: number, h: number, config: CustomConfig) => {
		const id = addWidget(doc, "custom", { x, y }, config);
		const shape = shapesMap(doc).get(id);
		shape?.set("w", w);
		shape?.set("h", h);
		return id;
	};
	const example = (id: string) => {
		const found = CUSTOM_EXAMPLES.find((each) => each.id === id);
		if (!found) throw new Error(`No example ${id}`);
		return exampleConfig(found, REPO);
	};
	// Two columns, clear of the playground's panel: somewhere to start, and the check, first.
	place(40, 40, 400, 320, { title: "", code: "", data: "{}" });
	place(480, 40, 420, 340, { title: "Sandbox check", code: SANDBOX_CHECK, data: "{}" });
	place(40, 400, 400, 320, {
		...example("burndown"),
		data: JSON.stringify({ repo: REPO, milestone: MILESTONE }, null, 2),
	});
	place(480, 400, 420, 320, example("labels"));
	place(40, 760, 400, 340, {
		...example("contributors"),
		data: JSON.stringify({ query: `repo:${REPO} is:pr`, limit: 8 }, null, 2),
	});
}
