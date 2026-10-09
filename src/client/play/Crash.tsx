// Throws while rendering, to show the error boundary's fallback and exercise
// client error reporting end to end.
export default function Crash(): never {
	throw new Error("Deliberate crash from /play/crash");
}
