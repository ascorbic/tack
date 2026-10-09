# Spike: live cards on React Flow + Yjs

Goal: prove the riskiest parts of the architecture before committing to it.

## What's built

- **`Board`** (Durable Object, one per board): a `y-partyserver` `YServer` holding the Yjs document. Snapshots are compacted on save and chunked into 512 KB SQLite rows (DO rows max out at 2 MB). Live card data goes to clients as y-partyserver custom messages, never into the document.
- **`Repo`** (Durable Object, one per repository): caches normalised cards, tracks which boards reference which cards, logs raw webhook deliveries, dedupes by delivery id, ignores out-of-order payloads, and fans updates out to subscribed boards over RPC.
- **`POST /webhooks/github`**: verifies `X-Hub-Signature-256`, routes `issues` and `pull_request` events to the right `Repo`.
- **Client**: React Flow canvas over a `shapes` Y.Map (one Y.Map per shape, fractional-index z-order). Paste or type an issue/PR reference to add a live card; stickies sync as you type.

Try it:

```sh
pnpm dev
# open /, create a board (or /?board=demo, which now redirects to /b/demo/demo), add ascorbic/unpic#100
node scripts/send-webhook.ts pull_request payload.json http://localhost:5173/webhooks/github
# open /?board=stress-500&stress=500 for the stress board (the stress param carries over)
```

## Findings

**React Flow with hundreds of DOM cards is fine.** 500 rich cards, measured in a hidden (throttled) browser tab, so treat these as relative:

| Case                           | Cost per zoom step (minus ~8.5 ms harness overhead) | Nodes in DOM |
| ------------------------------ | --------------------------------------------------- | ------------ |
| Zoomed out, ~460 cards visible | ~8 ms                                               | 458          |
| Zoomed in, culled              | ~3.5 ms                                             | 2            |

`onlyRenderVisibleElements` culls correctly once nodes are measured. Viewport changes don't re-render nodes because node objects keep their identity. Real-browser FPS still needs checking on a visible tab (`?stress=500` shows an FPS counter).

**Writing every drag frame to Yjs would bloat boards.** Each position write leaves a tombstone of roughly 10 bytes that survives compaction (800 shapes, simulated in Node):

| Strategy                              | Growth                                     |
| ------------------------------------- | ------------------------------------------ |
| x and y as separate keys, every frame | ~19 bytes per frame (50k frames → +930 KB) |
| One `pos` key, every frame            | ~9 bytes per frame                         |
| Commit on drag end only (~420 drags)  | +6 KB total                                |

So in-progress drags now travel as awareness state (ephemeral, rAF-throttled) and only the final position is written to the document. Other clients see drags live via awareness.

**Snapshot size**: 800 shapes ≈ 105–130 KB fresh. With drag-end commits, a long-lived board stays well under one 512 KB chunk.

## Bugs found and fixed

- The node store's snapshot could miss the initial sync if it landed before React subscribed. It now rebuilds on subscribe.
- Untyped self-referencing DO bindings in the experimental config: `src/server/namespaces.ts` restores class types for RPC.

## Not done yet (next steps)

- GitHub App: installation tokens, user login, per-viewer permission filtering (cards from private repos currently go to every viewer of a board).
- Key `Repo` by repository id, not name.
- CI rollup and review state on PR cards (needs GraphQL `statusCheckRollup`).
- Reconcile on wake and redelivery of failed webhooks.
- Debounce `Board.syncSubscriptions`: it scans all shapes on every document update.
- Remote cursors, undo (`Y.UndoManager` with local origin), connectors, frames, pen.
- A tombstone-compaction strategy for very old boards (e.g. `unstable_replaceDocument` from a JSON rebuild).
