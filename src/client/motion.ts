/**
 * The current motion scale from the `--motion` token: 1 normally, 10 in the
 * playground's slow motion, and near zero for reduced motion. Animations
 * driven from script (rather than CSS) multiply their durations by this.
 */
export function motionScale(): number {
	const value = Number.parseFloat(
		getComputedStyle(document.documentElement).getPropertyValue("--motion"),
	);
	return Number.isFinite(value) ? value : 1;
}

/** A duration in milliseconds, scaled for motion; zero when reduced. */
export function scaledDuration(ms: number): number {
	const scaled = ms * motionScale();
	return scaled < 1 ? 0 : Math.round(scaled);
}
