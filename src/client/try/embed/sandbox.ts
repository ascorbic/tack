// The live embeds keep nothing, and play the same every time: imported
// before anything else in the embed's entry, so no module reads the real
// storage or randomness first.

/** Storage that lasts as long as the page: the embed saves nothing in this browser. */
class MemoryStorage implements Storage {
	private items = new Map<string, string>();
	get length(): number {
		return this.items.size;
	}
	clear(): void {
		this.items.clear();
	}
	getItem(key: string): string | null {
		return this.items.get(key) ?? null;
	}
	key(index: number): string | null {
		return [...this.items.keys()][index] ?? null;
	}
	removeItem(key: string): void {
		this.items.delete(key);
	}
	setItem(key: string, value: string): void {
		this.items.set(key, String(value));
	}
}

/** localStorage and sessionStorage, for this page only. */
export function forgetEverything(): void {
	for (const name of ["localStorage", "sessionStorage"] as const) {
		Object.defineProperty(window, name, {
			configurable: true,
			value: new MemoryStorage(),
		});
	}
}

let seed = 1;

/** mulberry32: small, fast and good enough for jitter. */
function next(): number {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = seed;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * `Math.random`, from a seed: the simulations' jitter (how long a push
 * takes, where a cursor wanders) is the same on every loop.
 */
export function reseed(value: number): void {
	seed = value | 0;
	Math.random = next;
}

forgetEverything();
reseed(1);
