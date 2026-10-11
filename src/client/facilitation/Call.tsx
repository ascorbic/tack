import { useEffect, useRef } from "react";
import type { Awareness } from "y-protocols/awareness";
import { useAwarenessField } from "../ephemeral.ts";
import type { RemotePresence } from "../presence.ts";
import type { ToastStore } from "../Toasts.tsx";

// Calling everyone over: a lighter "everyone, look here" than spotlight.
// Nobody is moved or made to follow: everyone else gets a toast ("Matt is
// calling everyone") with Go there, which takes them to what the caller is
// looking at, once. It travels as awareness, like emotes, and clears itself.

/** A call, in awareness: `n` counts up so a second call shows again. */
export interface Call {
	n: number;
}

/** How long a call stays out there, for people a little slow to see it. */
export const CALL_MS = 8_000;

let calls = 0;
let clear: ReturnType<typeof setTimeout> | undefined;

/** Call everyone over to what you're looking at. */
export function callEveryone(awareness: Awareness): void {
	awareness.setLocalStateField("call", { n: ++calls } satisfies Call);
	clearTimeout(clear);
	clear = setTimeout(() => {
		if (awareness.getLocalState()) awareness.setLocalStateField("call", null);
	}, CALL_MS);
}

/** Toasts for other people's calls, with a way to go to them. */
export function useCalls({
	awareness,
	people,
	toasts,
	onGo,
}: {
	awareness: Awareness;
	people: RemotePresence[];
	toasts: ToastStore;
	/** Go to where someone's looking, once. */
	onGo: (clientId: number) => void;
}): void {
	const [remote] = useAwarenessField<Call>(awareness, "call");
	// (A call still out there when you arrive is for you too.)
	const seen = useRef(new Map<number, number>());
	const latest = useRef({ people, onGo });
	latest.current = { people, onGo };
	useEffect(() => {
		for (const { clientId, value } of remote) {
			if (typeof value?.n !== "number") continue;
			const last = seen.current.get(clientId);
			seen.current.set(clientId, value.n);
			if (last !== undefined && value.n <= last) continue;
			const person = latest.current.people.find((p) => p.clientId === clientId);
			const name = person?.user.name ?? "Someone";
			toasts.show({
				message: `${name} is calling everyone over`,
				action: { label: "Go there", run: () => latest.current.onGo(clientId) },
			});
		}
	}, [remote, toasts]);
}
