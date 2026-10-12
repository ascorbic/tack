import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/shantell-sans/infm.css";
import "@xyflow/react/dist/style.css";
import "../styles.css";
import "./try.css";
import { ErrorBoundary } from "../ErrorBoundary.tsx";
import { initTheme } from "../useTheme.ts";
import { startDemo } from "./start.ts";
import { TryApp } from "./TryApp.tsx";

// tack.social/try (#75): a board to play with, entirely in the browser. It's
// built on its own (`vp build --mode try`, see vite.config.ts) from the
// playground's simulations, with no Worker, no sign-in and nothing sent
// anywhere: there's nowhere to report errors to, and pushes go to a pretend
// forge, named as such.

startDemo();
initTheme();

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<ErrorBoundary>
			<TryApp />
		</ErrorBoundary>,
	);
}
