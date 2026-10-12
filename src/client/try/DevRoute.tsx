import "./try.css";
import { startDemo } from "./start.ts";
import { TryApp } from "./TryApp.tsx";

// The demo on the app's own dev server, at /play/try, so the e2e tests can
// drive it without a second server. The published demo is its own page
// (main.tsx, `vp build --mode try`); this is the same app.

startDemo();

export default TryApp;
