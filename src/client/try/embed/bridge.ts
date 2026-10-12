// How a live embed and the landing page around it talk (postMessage, same
// origin only). The page says whether the embed's on screen, and which theme
// it's in; the embed says when it's ready to be seen (the poster fades), when
// someone's taken it over, and passes scrolling on, so the page scrolls over
// a board that's playing by itself. site/src/components/LiveDemo.astro is
// the other end, and repeats these names.

/** What the page tells the embed. */
export type FromPage =
	| { tack: "embed"; type: "visible"; visible: boolean }
	| { tack: "embed"; type: "theme"; theme: "light" | "dark" }
	| { tack: "embed"; type: "takeover" };

/** What the embed tells the page. */
export type ToPage =
	| { tack: "embed"; type: "ready" }
	| { tack: "embed"; type: "yours" }
	| { tack: "embed"; type: "scroll"; dx: number; dy: number };

export function framed(): boolean {
	return window.parent !== window;
}

export function tellPage(message: ToPage): void {
	if (framed()) window.parent.postMessage(message, location.origin);
}

/** Hear the page, only from this origin. Returns the way to stop. */
export function hearPage(listener: (message: FromPage) => void): () => void {
	const onMessage = (event: MessageEvent) => {
		if (event.origin !== location.origin || event.source !== window.parent) return;
		const data = event.data as Partial<FromPage> | null;
		if (data?.tack !== "embed" || typeof data.type !== "string") return;
		listener(data as FromPage);
	};
	window.addEventListener("message", onMessage);
	return () => window.removeEventListener("message", onMessage);
}
