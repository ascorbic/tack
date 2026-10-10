// The timer's end chime: a soft, two-note bell made with Web Audio, so
// there's no sound file to load. People can turn it off (it's remembered).

const KEY = "tack:chime";

export function chimeEnabled(): boolean {
	try {
		return localStorage.getItem(KEY) !== "off";
	} catch {
		return true;
	}
}

export function setChimeEnabled(on: boolean): void {
	try {
		localStorage.setItem(KEY, on ? "on" : "off");
	} catch {}
}

let context: AudioContext | null = null;

/** Ring the bell, gently. Silently does nothing where audio isn't allowed. */
export function chime(): void {
	if (!chimeEnabled()) return;
	try {
		context ??= new AudioContext();
		const ctx = context;
		if (ctx.state === "suspended") void ctx.resume();
		const start = ctx.currentTime + 0.02;
		const out = ctx.createGain();
		out.gain.value = 0.18;
		out.connect(ctx.destination);
		// Two strikes a fifth apart, each a fundamental with a quiet, bright partial.
		for (const [at, freq] of [
			[0, 784],
			[0.22, 1175],
		] as const) {
			for (const [ratio, level] of [
				[1, 1],
				[2.76, 0.18],
			] as const) {
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.type = "sine";
				osc.frequency.value = freq * ratio;
				gain.gain.setValueAtTime(0, start + at);
				gain.gain.linearRampToValueAtTime(level, start + at + 0.012);
				gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 1.6);
				osc.connect(gain).connect(out);
				osc.start(start + at);
				osc.stop(start + at + 1.7);
			}
		}
	} catch {
		// No audio here (or not yet allowed): the visual is enough.
	}
}
