import type { ForgeId } from "../../shared/refs.ts";
import { fake } from "./fake.ts";
import { github } from "./github.ts";
import type { ForgeAdapter } from "./types.ts";

export type { Delivery, ForgeAdapter, ForgeCapabilities, WebhookResult } from "./types.ts";

const ADAPTERS: Record<ForgeId, ForgeAdapter> = { github, fake };

export function forge(id: ForgeId): ForgeAdapter {
	return ADAPTERS[id];
}

/** Look up an adapter from a URL path segment, e.g. `/webhooks/github`. */
export function forgeByName(name: string): ForgeAdapter | null {
	return name in ADAPTERS ? ADAPTERS[name as ForgeId] : null;
}
