import type { ForgeId } from "../../shared/refs.ts";
import { fake } from "./fake.ts";
import { forgejo } from "./forgejo.ts";
import { github } from "./github.ts";
import { gitlab } from "./gitlab.ts";
import { tangled } from "./tangled.ts";
import type { ForgeAdapter } from "./types.ts";

export type {
	ApplyOptions,
	ApplyResult,
	BranchResult,
	BranchWrite,
	CommandReaction,
	CommentCommand,
	Delivery,
	FetchRef,
	ForgeAdapter,
	ForgeCapabilities,
	MissingReason,
	PollResult,
	ReadAuth,
	ReplyResult,
	RepoIdentity,
	WebhookResult,
	WriteAuth,
} from "./types.ts";

const ADAPTERS: Record<ForgeId, ForgeAdapter> = { github, fake, forgejo, gitlab, tangled };

export function forge(id: ForgeId): ForgeAdapter {
	return ADAPTERS[id];
}

/** Look up an adapter from a URL path segment, e.g. `/webhooks/github`. */
export function forgeByName(name: string): ForgeAdapter | null {
	return name in ADAPTERS ? ADAPTERS[name as ForgeId] : null;
}
