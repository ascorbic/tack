// A message for the next page this tab loads, for things that end in a
// navigation: "You left “Roadmap”", "Signed out". Kept in session storage,
// read once, and gone if storage is blocked (nothing breaks without it).

const KEY = "tack:flash";

/** How old a flash can be and still be shown: it's for the page that loads next. */
const FRESH_MS = 30_000;

export interface Flash {
	message: string;
	/** Undo, or another way back, as a link. */
	action?: { label: string; href: string };
}

export function setFlash(flash: Flash): void {
	try {
		sessionStorage.setItem(KEY, JSON.stringify({ ...flash, at: Date.now() }));
	} catch {}
}

export function takeFlash(): Flash | null {
	try {
		const raw = sessionStorage.getItem(KEY);
		if (!raw) return null;
		sessionStorage.removeItem(KEY);
		const flash = JSON.parse(raw) as Flash & { at?: number };
		if (typeof flash.message !== "string") return null;
		if (typeof flash.at !== "number" || Date.now() - flash.at > FRESH_MS) return null;
		return { message: flash.message, ...(flash.action ? { action: flash.action } : {}) };
	} catch {
		return null;
	}
}
