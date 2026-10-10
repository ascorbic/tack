import { useSyncExternalStore } from "react";
import type { Me, Person } from "../../shared/auth.ts";
import { boardIdFromPath } from "../../shared/boards.ts";
import { setFlash } from "../flash.ts";
import { COLORS, type User } from "../presence.ts";

// Who's signed in, from `/api/me`, loaded once per page.

export type MeState = { status: "loading" } | { status: "ready"; me: Me };

/** If `/api/me` can't be reached, carry on as an anonymous guest. */
const OFFLINE: Me = {
	viewer: null,
	admin: false,
	allowed: true,
	signIn: "unavailable",
	devAuth: false,
};

let state: MeState = { status: "loading" };
let started = false;
const listeners = new Set<() => void>();

function set(next: MeState): void {
	state = next;
	for (const listener of listeners) listener();
}

async function load(): Promise<void> {
	try {
		const response = await fetch("/api/me", { headers: { accept: "application/json" } });
		set({ status: "ready", me: response.ok ? ((await response.json()) as Me) : OFFLINE });
	} catch {
		set({ status: "ready", me: OFFLINE });
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (!started) {
		started = true;
		void load();
	}
	return () => listeners.delete(listener);
}

export function useMe(): MeState {
	return useSyncExternalStore(subscribe, () => state);
}

/** Where to send someone to sign in, coming back here afterwards. */
export function signInHref(returnTo = location.pathname + location.search + location.hash): string {
	return `/auth/signin?return_to=${encodeURIComponent(returnTo)}`;
}

/** Fake sign-in for local development (`TACK_DEV_AUTH=1`). */
export function devSignInHref(
	login: string,
	returnTo = location.pathname + location.search + location.hash,
): string {
	const params = new URLSearchParams({ login, return_to: returnTo });
	return `/auth/dev?${params.toString()}`;
}

/** End the session, then reload so the board reconnects as a guest, and say so when it does. */
export async function signOut(): Promise<void> {
	await fetch("/auth/signout", { method: "POST", headers: { accept: "application/json" } });
	setFlash({
		message: boardIdFromPath(location.pathname)
			? "Signed out. You’re here as a guest now."
			: "Signed out.",
	});
	location.reload();
}

/** A colour for a person, stable across sessions and devices. */
export function personColor(id: number): string {
	const hash = Math.imul(id ^ (id >>> 16), 0x45d9f3b) >>> 0;
	return COLORS[hash % COLORS.length] ?? "#3b4cca";
}

/** A signed-in person as they appear in presence: name, avatar and colour. */
export function personUser(person: Person): User {
	return {
		name: person.name || person.login,
		color: personColor(person.id),
		login: person.login,
		avatarUrl: person.avatarUrl,
	};
}
