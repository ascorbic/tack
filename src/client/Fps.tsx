import { useEffect, useState } from "react";

/** Frames per second over the last second, for stress testing. */
export function Fps() {
	const [fps, setFps] = useState(0);
	useEffect(() => {
		let frames = 0;
		let last = performance.now();
		let raf = requestAnimationFrame(function tick(now) {
			frames++;
			if (now - last >= 1000) {
				setFps(Math.round((frames * 1000) / (now - last)));
				frames = 0;
				last = now;
			}
			raf = requestAnimationFrame(tick);
		});
		return () => cancelAnimationFrame(raf);
	}, []);
	return (
		<output className="fps" aria-label="Frames per second">
			{fps} fps
		</output>
	);
}
