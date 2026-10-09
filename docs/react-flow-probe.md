# React Flow probe

React Flow is a node-and-edge editor; Tack is a whiteboard. Before building more of the canvas on it, this probe tried the whiteboard primitives most likely to fight it (#2). Each has a working prototype in `/play`, and sections and connectors (#16, #17) are now built on what it found.

**Recommendation: keep React Flow as the node renderer, and put everything that isn't a box on our own layers inside its viewport.** Cards, stickies and sections stay React Flow nodes. Connectors, and later pen strokes and free arrows, are drawn on our own SVG layer with our own geometry and hit testing. Containment is ours too, not React Flow's `parentId`. No primitive needed the engine replaced, and the data model never mentions React Flow, so that option stays open.

## What was tried

| Primitive                                                                                  | Where                        | Verdict                               |
| ------------------------------------------------------------------------------------------ | ---------------------------- | ------------------------------------- |
| Connectors with loose ends; drawing into empty space; re-attaching an end to another shape | `/play?scenario=connectors`  | Own layer                             |
| Ends that attach anywhere on a shape's outline and follow it                               | same                         | Own layer                             |
| Frames: dropping shapes in and out, moving with contents, stacking                         | `/play?scenario=sections`    | React Flow nodes, our own containment |
| Pen strokes and free arrows, with our own hit testing                                      | `/play` → "Probe: pen layer" | Own layer                             |

### Connectors: our own layer, not edges

React Flow edges assume a graph:

- **Both ends need a node.** A loose end would need an invisible "anchor" node per end, which then shows up in selection, the minimap, `fitView` and every node-handling code path.
- **Ends attach to handles**, fixed points declared by the node component. The "floating edges" example works around this by ignoring handles and intersecting the node's box, but reconnecting (`edgesReconnectable`, `onReconnect`) is still handle-based, so re-attaching to an arbitrary point on another shape means fighting it.
- **Edges render in a separate SVG beneath all nodes**, so a connector can't sit above the cards it joins.
- Edge selection follows node selection (the marquee selects edges connected to selected nodes), which isn't how a whiteboard behaves.

Instead, connectors are drawn by `ConnectorLayer` (`src/client/connectors.tsx`), an SVG inside React Flow's `ViewportPortal`, so it pans and zooms with the board for free. Everything else is ours:

- **Ends** (`ConnectorEnd` in `src/shared/shapes.ts`) are either a point, or a shape with an optional anchor on its outline. With an anchor, the end is pinned to that spot and follows the shape as it moves or resizes. Without one, it floats around the outline, aiming at the other end. `endAt` decides which when an end is dropped: near the outline it pins (snapping to the middle of a side), well inside it floats, and sections only take ends near their edge so you can still leave an end loose inside one.
- **Routing** (`routeConnector`) does curved, straight and elbow lines from the ends' side normals, with arrowheads and trims, as pure functions over boxes.
- **Hit testing** for picking a line uses a wide transparent stroke (constant on screen at any zoom). Pointer handling is ours: capture-phase listeners on React Flow's DOM node for the connector tool, and plain elements for end handles and the hover handles around shapes.
- **Geometry comes from the nodes we pass React Flow**, which already carry drag overrides and measured sizes, so connectors follow drags (local and remote) and section moves with no extra plumbing.

Cost: on the 500-card stress board with 270 connectors, 20 of them bound to the card being dragged, a drag frame took a median 7.9 ms (p90 12 ms) against 5.3 ms with no connectors, measured from a synthetic pointer event to the next task in a dev build. Every connector is re-routed each frame; caching routes whose ends didn't move is the obvious next step if boards get busier.

Panning and zooming don't re-render connectors at all (they're inside the transformed viewport); a zoom change re-routes them once, since snap distances and handle sizes depend on it.

### Frames: nodes, but not `parentId`

React Flow's sub-flows (`parentId`) do move children with their parent, but:

- **Child positions become relative to the parent.** Our document, awareness drags and the server would all have to convert, and a concurrent reparent plus move would apply one person's relative coordinates to the other's parent.
- **Parents must come before children in the nodes array**, a topological order on top of our fractional-index order.
- **It owns stacking.** In the default z-index mode each child gets at least its parent's z + 1, and each root parent is bumped by 10 more than the last, so a section's contents always stack above every shape outside any section, whatever their fractional index says.
- It doesn't decide containment. Dropping into or out of a parent is still up to us.

So sections are ordinary nodes and containment is ours:

- Each shape has a `parent` key (the section it's in, or null) and **absolute coordinates**. Containment is decided geometrically when something is committed (the topmost section under the shape's centre that's bigger than it, `containerFor`), then stored, so it reads the same everywhere, including on the server, without knowing how big anything rendered.
- Sections sort first in the node array, outer before inner, with `zIndex` below zero (`SECTION_Z`) so React Flow lifting a selected node by 1000 still leaves a selected section beneath its contents. Everything else keeps its fractional-index order and React Flow's default behaviour.
- While a section is dragged, its contents follow as derived position overrides (`useCanvasStructure`); only the section's own position travels through awareness. On drop, `commitMoves` writes the section, its contents and any loose connector ends inside it in one transaction. This costs the same per frame as `parentId` would: React Flow re-renders the wrappers of moved children either way.
- The section body lets pointer events through (dragging inside a section draws a selection box, as in FigJam), and only its title is a drag handle.

### Pen strokes: our own layer and hit testing

`src/client/play/PenProbe.tsx` draws strokes on another SVG inside the viewport and erases them by geometry alone: a bounding-box check, then distance to each stroke's polyline (`distanceToPolyline` in `src/shared/geometry.ts`). With 300 scribbled strokes, an eraser hit test takes about 0.1 ms. Strokes are kept in a separate map in the playground document (`probe:strokes`); they aren't in the board schema yet.

Free arrows are connectors with two loose ends, so they come with the connector layer.

## Where React Flow still fights us

None of these blocked anything, but they're the seams to watch:

- **One stacking context.** Our layers sit at one z-index (connectors at 1500, above resting shapes and below dragged ones) rather than interleaving with nodes by fractional index. A connector can't pass under one card and over another. If that matters, the options are rendering each connector as a node (giving up our hit testing) or drawing nodes ourselves.
- **Selection is React Flow's.** Its marquee only knows nodes, so connectors join the shared `selected` set by click and shift-click only. Marquee selection of connectors and strokes needs our own pass over geometry; the hit-testing functions are ready for it.
- **Pointer events.** Our tools listen in the capture phase on React Flow's DOM node to get ahead of its drag and selection handlers, and our elements use `nodrag`/`nopan`. It works, but it's a convention every new tool has to follow.
- **Drag handling** is d3-drag under the hood and only reports node positions. Anything richer (snapping, alignment guides, our own drop rules) hangs off position changes rather than a drag API we control.

## Data model

Unchanged in spirit: one `Y.Map` per shape in `shapes`, one property per key, fractional-index `z`. Sections and connectors add keys, documented at the top of `src/shared/shapes.ts`. Two rules came out of the probe:

- **A committed move writes `x`, `y` and `parent` together**, even when the parent is unchanged or null. Yjs resolves concurrent writes to a map key by client, consistently across keys, so two concurrent moves end up as one person's position and section, never a mix. Deleting the key wouldn't work: a delete never beats a concurrent set.
- **References can dangle** after concurrent edits (a section deleted while someone drops into it; a card deleted while someone attaches to it). Clients render them tolerantly: a missing parent means top-level, an end bound to a missing shape is drawn loose where it was attached, a point every bound end stores when it is placed. (It is not updated as the shape moves: rewriting the end on every move could undo a concurrent re-attach. Since dangling ends only come from races, the point is recent anyway.) The `Board` Durable Object runs a repair pass (`src/shared/repair.ts`) shortly after any edit that adds or deletes a shape or changes a reference, and writes the fix so every client converges on it. Deleting a shape locally detaches its connectors in the same transaction, so the repair pass only sees genuine races (`/play` → "Delete while connecting" reproduces one).

## Decision

- **Keep React Flow** for cards, stickies and sections.
- **Own layers** for connectors (done), pen strokes and free arrows (prototype), and probably any future shape that isn't a box.
- **Own containment, own geometry, own hit testing** in `src/shared`, so a future engine change (or a server-side renderer for embeds, M5) reuses them.
- **Pen and freeform drawing**: the layer approach works and is cheap; schedule it after M1 as planned, as a `stroke` shape type with points stored per stroke.
- **Revisit** if we need connectors interleaved with shapes in z-order, or if marquee and snapping across our layers turn into more glue than a custom DOM+SVG engine would be.
