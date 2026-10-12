import { useMemo } from "react";
import { encode } from "uqr";

// A QR code for a board's link (the share dialog's QR button): drawn as one
// path of dots, with its three corner markers as rounded squares, so it
// reads as Tack's rather than a printout. Always dark on light, whatever the
// theme: scanners read that best.

/** The corner markers' size, in modules. */
const FINDER = 7;

function inFinder(x: number, y: number, size: number): boolean {
	const near = (v: number, edge: number) => v >= edge && v < edge + FINDER;
	return (
		(near(x, 0) && near(y, 0)) ||
		(near(x, size - FINDER) && near(y, 0)) ||
		(near(x, 0) && near(y, size - FINDER))
	);
}

export function QrCode({ value, label }: { value: string; label: string }) {
	const { size, dots, finders } = useMemo(() => {
		const qr = encode(value, { ecc: "M", border: 0 });
		const size = qr.size;
		let dots = "";
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				if (!qr.data[y]?.[x] || inFinder(x, y, size)) continue;
				// A dot a touch smaller than its module, so the pattern breathes.
				dots += `M${x + 0.5} ${y + 0.08}a.42.42 0 1 1 0 .84a.42.42 0 1 1 0-.84z`;
			}
		}
		const corners = [
			[0, 0],
			[size - FINDER, 0],
			[0, size - FINDER],
		] as const;
		return { size, dots, finders: corners };
	}, [value]);
	const quiet = 2;

	return (
		<svg
			className="qr-code"
			viewBox={`${-quiet} ${-quiet} ${size + quiet * 2} ${size + quiet * 2}`}
			role="img"
			aria-label={label}
		>
			<rect
				x={-quiet}
				y={-quiet}
				width={size + quiet * 2}
				height={size + quiet * 2}
				rx={2.4}
				fill="#fff"
			/>
			<path d={dots} fill="#17191c" />
			{finders.map(([x, y]) => (
				<g key={`${x},${y}`}>
					<rect
						x={x + 0.5}
						y={y + 0.5}
						width={FINDER - 1}
						height={FINDER - 1}
						rx={1.8}
						fill="none"
						stroke="#17191c"
						strokeWidth={1}
					/>
					<rect x={x + 2} y={y + 2} width={3} height={3} rx={0.9} fill="#3b4cca" />
				</g>
			))}
		</svg>
	);
}
