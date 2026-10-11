// Presence (Yjs awareness) as the board's server relays it (#60).
//
// Awareness is ephemeral state each client publishes about itself (cursor,
// view, who it is), and y-partyserver relays it to everyone as sent. Left
// alone, any connection, a signed-out visitor to a public board included,
// could claim to be anyone (another person's login, name and avatar, which
// the people list, cursors and history's attribution show) or rewrite or
// remove other clients' states. So each awareness message is checked on its
// way in:
//
// - a client id belongs to the first connection that speaks for it; others'
//   updates to it are dropped;
// - who someone is comes from the Worker's access check, never the client:
//   signed-in people get their own login, name and avatar; guests get none
//   (a guest's made-up name stays, without a login or picture);
// - states are bounded in size, and malformed updates are dropped whole.

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

/** Largest awareness state relayed, in bytes of JSON. */
export const MAX_STATE_BYTES = 32 * 1024;
const MAX_NAME = 80;
const MAX_COLOR = 32;

/** Who's on a connection, as the Worker's access check said. */
export interface AwarenessIdentity {
	connection: string;
	person?: { login: string; name: string | null; avatarUrl: string };
}

export interface SanitizedAwareness {
	/** The update to relay, or null if nothing in it may be. */
	update: Uint8Array | null;
	/** Client ids this connection now speaks for. */
	claimed: number[];
	/** Entries dropped: someone else's client, too large, or not JSON. */
	dropped: number;
}

/**
 * Check an awareness update from a connection. `owner` says which
 * connection speaks for a client id, if any does yet.
 */
export function sanitizeAwareness(
	update: Uint8Array,
	identity: AwarenessIdentity,
	owner: (clientId: number) => string | undefined,
): SanitizedAwareness {
	const entries: { clientId: number; clock: number; state: string }[] = [];
	let dropped = 0;
	try {
		const decoder = decoding.createDecoder(update);
		const count = decoding.readVarUint(decoder);
		for (let i = 0; i < count; i++) {
			const clientId = decoding.readVarUint(decoder);
			const clock = decoding.readVarUint(decoder);
			const json = decoding.readVarString(decoder);
			const held = owner(clientId);
			if (held !== undefined && held !== identity.connection) {
				dropped++;
				continue;
			}
			const state = cleanState(json, identity);
			if (state === undefined) {
				dropped++;
				continue;
			}
			entries.push({ clientId, clock, state });
		}
	} catch {
		return { update: null, claimed: [], dropped: dropped + 1 };
	}
	if (entries.length === 0) return { update: null, claimed: [], dropped };
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, entries.length);
	for (const entry of entries) {
		encoding.writeVarUint(encoder, entry.clientId);
		encoding.writeVarUint(encoder, entry.clock);
		encoding.writeVarString(encoder, entry.state);
	}
	return {
		update: encoding.toUint8Array(encoder),
		claimed: entries.map((entry) => entry.clientId),
		dropped,
	};
}

/** A state's JSON with its `user` made true, or undefined to drop it. */
function cleanState(json: string, identity: AwarenessIdentity): string | undefined {
	if (json.length > MAX_STATE_BYTES) return undefined;
	let state: unknown;
	try {
		state = JSON.parse(json);
	} catch {
		return undefined;
	}
	// Null is a client leaving: always fine for its own id.
	if (state === null) return "null";
	if (typeof state !== "object" || Array.isArray(state)) return undefined;
	const record = state as Record<string, unknown>;
	if (!("user" in record)) return json;
	const claimed = (typeof record.user === "object" && record.user) || {};
	const { name, color } = claimed as { name?: unknown; color?: unknown };
	const person = identity.person;
	const user: Record<string, string> = {
		name: person
			? (person.name || person.login).slice(0, MAX_NAME)
			: (typeof name === "string" ? name : "Guest").slice(0, MAX_NAME),
		color: typeof color === "string" ? color.slice(0, MAX_COLOR) : "",
	};
	if (person) {
		user.login = person.login;
		user.avatarUrl = person.avatarUrl;
	}
	return JSON.stringify({ ...record, user });
}
