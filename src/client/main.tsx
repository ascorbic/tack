import { type ComponentType, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/shantell-sans/infm.css";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App.tsx";
import { SignInRoute } from "./auth/AccessGate.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { installErrorHandlers } from "./errors.ts";
import { initTheme } from "./useTheme.ts";

installErrorHandlers();
initTheme();

const routes: Record<string, ComponentType> = {
	"/signin": SignInRoute,
	"/setup": lazy(() => import("./auth/SetupPage.tsx")),
	// The playground and galleries are development tools, left out of
	// production builds entirely.
	...(import.meta.env.DEV
		? {
				"/play": lazy(() => import("./play/Playground.tsx")),
				"/play/cards": lazy(() => import("./play/Gallery.tsx")),
				"/play/auth": lazy(() => import("./play/AuthGallery.tsx")),
				"/play/boards": lazy(() => import("./play/BoardsGallery.tsx")),
				"/play/actions": lazy(() => import("./play/ActionsGallery.tsx")),
				"/play/crash": lazy(() => import("./play/Crash.tsx")),
			}
		: {}),
};

const Page = routes[location.pathname.replace(/\/$/, "")] ?? App;

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<ErrorBoundary>
			<Suspense>
				<Page />
			</Suspense>
		</ErrorBoundary>,
	);
}
