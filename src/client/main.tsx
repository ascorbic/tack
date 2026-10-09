import { type ComponentType, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/bricolage-grotesque";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { installErrorHandlers } from "./errors.ts";

installErrorHandlers();

// The playground and gallery are development tools, left out of production
// builds entirely.
const routes: Record<string, ComponentType> = import.meta.env.DEV
	? {
			"/play": lazy(() => import("./play/Playground.tsx")),
			"/play/cards": lazy(() => import("./play/Gallery.tsx")),
			"/play/crash": lazy(() => import("./play/Crash.tsx")),
		}
	: {};

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
