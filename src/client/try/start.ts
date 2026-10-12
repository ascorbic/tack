import { nameForge } from "../../shared/refs.ts";
import { stopReporting } from "../errors.ts";
import { stayInTheBrowser } from "./network.ts";

/**
 * Make this page the public demo (#75): nothing it does leaves the browser,
 * there's nowhere to report errors to, and pushes go to a pretend forge,
 * named as such. Before anything renders.
 */
export function startDemo(): void {
	stayInTheBrowser();
	stopReporting();
	nameForge("fake.tack", "the demo forge", { byDefault: true });
}
