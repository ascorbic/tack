// A custom widget (#66) for the playground and e2e tests: it tries the ways
// out of its sandbox, and shows each one closed.

/** Tries the ways out of the sandbox, and shows each is closed. */
export const SANDBOX_CHECK = `// Sandbox check: tries the ways a widget might reach out, and shows each one closed.
const checks = [
  ["fetch()", () => fetch("https://example.com/?leak=1")],
  ["Images", () => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = resolve;
    image.onerror = () => reject(new Error("blocked"));
    image.src = "https://example.com/pixel.png?leak=1";
  })],
  ["WebSocket", () => new Promise((resolve, reject) => {
    const socket = new WebSocket("wss://example.com/");
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("blocked"));
  })],
  ["Cookies", () => Promise.resolve(document.cookie.length)],
  ["Storage", () => Promise.resolve(localStorage.length)],
  ["The board", () => Promise.resolve(parent.document.title)],
  ["Popups", () => (window.open("https://example.com/") ? Promise.resolve() : Promise.reject(new Error("blocked")))],
  ["WebRTC", () => Promise.resolve(new RTCPeerConnection())],
  // A frame of its own would have a fresh window, with WebRTC put back.
  ["WebRTC, in a new frame", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    try {
      return Promise.resolve(new frame.contentWindow.RTCPeerConnection());
    } finally {
      frame.remove();
    }
  }],
];

const list = document.createElement("ul");
const style = document.createElement("style");
style.textContent = \`
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px }
  li { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; border-bottom: 1px solid var(--line) }
  .result { font-weight: 600; color: var(--muted) }
  [data-result="blocked"] .result { color: var(--open) }
  [data-result="open"] .result { color: var(--fail) }\`;
document.body.replaceChildren(style, list);

for (const [name, attempt] of checks) {
  const row = document.createElement("li");
  row.dataset.check = name;
  const label = document.createElement("span");
  label.textContent = name;
  const result = document.createElement("span");
  result.className = "result";
  result.textContent = "Trying…";
  row.append(label, result);
  list.append(row);
  const settle = (outcome) => {
    row.dataset.result = outcome;
    result.textContent = outcome === "blocked" ? "✓ Blocked" : "Open";
  };
  try {
    Promise.race([
      Promise.resolve(attempt()).then(() => "open", () => "blocked"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 3000)),
    ]).then(settle);
  } catch {
    settle("blocked");
  }
}
`;
