// First: no module may reach the real storage, or the unseeded randomness, before this.
import "./sandbox.ts";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/shantell-sans/infm.css";
import "@xyflow/react/dist/style.css";
import "../../styles.css";
import { ErrorBoundary } from "../../ErrorBoundary.tsx";
import { EmbedApp } from "./EmbedApp.tsx";
import { featureOf, followPageTheme, startEmbed } from "./start.ts";

// tack.social/try/embed/?feature=stacks: one feature of the demo, live, for
// the landing page (site/src/components/LiveDemo.astro). Built with the demo
// (`vp build --mode try`), so it's the same files, cached once.

startEmbed();
followPageTheme();

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<ErrorBoundary>
			<EmbedApp
				feature={featureOf()}
				reduced={matchMedia("(prefers-reduced-motion: reduce)").matches}
			/>
		</ErrorBoundary>,
	);
}
