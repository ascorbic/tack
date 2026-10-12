import "./sandbox.ts";
import { EmbedApp } from "./EmbedApp.tsx";
import { featureOf, followPageTheme, startEmbed } from "./start.ts";

// A live embed on the app's own dev server, at /play/embed?feature=…, so the
// e2e tests can drive it without a second server. The published embed is
// its own page (main.tsx, built with the demo); this is the same app.

startEmbed();
followPageTheme();

export default function EmbedRoute() {
	return (
		<EmbedApp
			feature={featureOf()}
			reduced={matchMedia("(prefers-reduced-motion: reduce)").matches}
		/>
	);
}
