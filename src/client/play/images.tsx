import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { type ImageState, addImageShape, placedSize } from "../../shared/images.ts";
import { addSection, placeInSections } from "../../shared/structure.ts";
import { ImageView } from "../images/ImageNode.tsx";
import { type PreparedImage, prepareImage } from "../images/prepare.ts";
import { memoryImages } from "../images/service.ts";

// Images in the playground: files kept in this page's memory (nothing's
// sent anywhere), a moodboard scenario with Tack's own mark and a made-up
// chart, and the gallery of every state an image can be in.

/**
 * The playground's image files: in memory, with uploads that take a moment
 * (`window.tackImageDelay` milliseconds, for tests that act mid-upload).
 */
export const playImages = memoryImages({
	delayMs: () => (window as { tackImageDelay?: number }).tackImageDelay ?? 900,
});

/** Tack's mark, as the favicon draws it. */
export const TACK_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="480" height="480">
	<g transform="rotate(-5 12 14)">
		<path d="M4.5 6.5h15v12.2l-3.3 3.3H4.5z" fill="#ffd85c"/>
		<path d="M16.2 22v-3.3h3.3z" fill="#e8b93a"/>
	</g>
	<ellipse cx="12.6" cy="9.4" rx="3.1" ry="1.3" fill="#000" fill-opacity=".18"/>
	<circle cx="12" cy="7" r="3.4" fill="#e5533d"/>
	<circle cx="10.9" cy="5.9" r="1.1" fill="#fff" fill-opacity=".55"/>
</svg>`;

/** Tack's mark, drawn into a PNG the way a dropped SVG is. */
export function tackMark(): Promise<PreparedImage> {
	return prepareImage(new Blob([TACK_MARK_SVG], { type: "image/svg+xml" }));
}

/** A made-up chart, as if someone pasted a screenshot: unpic's bundle size by release. */
export async function madeUpChart(): Promise<PreparedImage> {
	const canvas = document.createElement("canvas");
	canvas.width = 1200;
	canvas.height = 720;
	const g = canvas.getContext("2d");
	if (!g) throw new Error("No canvas");
	g.fillStyle = "#fbfaf7";
	g.fillRect(0, 0, 1200, 720);
	g.fillStyle = "#17191c";
	g.font = "600 44px system-ui, sans-serif";
	g.fillText("unpic bundle size, kB (gzipped)", 70, 100);
	const bars = [
		["3.0", 14.2],
		["3.4", 12.8],
		["4.0", 9.6],
		["4.2", 8.1],
		["5.0β", 5.4],
	] as const;
	bars.forEach(([label, value], i) => {
		const x = 110 + i * 205;
		const h = value * 30;
		g.fillStyle = i === bars.length - 1 ? "#3b4cca" : "#c7ccf2";
		g.beginPath();
		g.roundRect(x, 620 - h, 130, h, 14);
		g.fill();
		g.fillStyle = "#5a5f66";
		g.font = "500 30px system-ui, sans-serif";
		g.fillText(label, x + 30, 670);
		g.fillStyle = "#17191c";
		g.fillText(String(value), x + 30, 600 - h);
	});
	const blob = await new Promise<Blob>((resolve, reject) =>
		canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("No PNG"))), "image/png"),
	);
	return prepareImage(blob);
}

/** Who's uploading, and when they gave up, for the states the scenario shows. */
const PRIYA = "Priya Shah";
const KAI = "Kai Andersen";

/**
 * A moodboard: Tack's mark with its alt text as a caption, a pasted chart,
 * one image Priya's uploading right now, one Kai gave up on, and one whose
 * file is gone. Drop, paste or pick your own (⇧⌘K).
 */
export function seedImages(doc: Y.Doc): void {
	doc.transact(() => {
		addSection(doc, { x: 40, y: 40, w: 1120, h: 560 }, { title: "Moodboard", color: "yellow" });
	});
	void (async () => {
		const [mark, chart] = await Promise.all([tackMark(), madeUpChart()]);
		for (const image of [mark, chart]) playImages.put(image.hash, image.blob);
		const markSize = placedSize({ w: mark.width, h: mark.height }, { w: 260, h: 260 });
		const chartSize = placedSize({ w: chart.width, h: chart.height }, { w: 440, h: 300 });
		const now = Date.now();
		const before = new Set(doc.getMap("shapes").keys());
		doc.transact(() => {
			addImageShape(doc, crypto.randomUUID(), {
				x: 90,
				y: 110,
				...markSize,
				iw: mark.width,
				ih: mark.height,
				mime: mark.type,
				image: mark.hash,
				alt: "Tack’s mark: a yellow sticky note, pinned with a red tack",
			});
			addImageShape(doc, crypto.randomUUID(), {
				x: 400,
				y: 110,
				...chartSize,
				iw: chart.width,
				ih: chart.height,
				mime: chart.type,
				image: chart.hash,
				alt: "unpic’s bundle size by release: down from 14.2 kB in 3.0 to 5.4 kB in the 5.0 beta",
			});
			// Uploading for someone else: a blurred stand-in that shimmers.
			addImageShape(doc, crypto.randomUUID(), {
				x: 880,
				y: 110,
				w: 240,
				h: 160,
				iw: 1200,
				ih: 800,
				mime: "image/png",
				preview: chart.preview,
				upload: { by: PRIYA, client: -1, at: new Date(now + 60 * 60_000).toISOString() },
			});
			// Kai closed their tab halfway.
			addImageShape(doc, crypto.randomUUID(), {
				x: 880,
				y: 330,
				w: 240,
				h: 160,
				iw: 1200,
				ih: 800,
				mime: "image/png",
				upload: { by: KAI, client: -2, at: new Date(now - 60 * 60_000).toISOString() },
			});
			// A file that isn't here any more.
			addImageShape(doc, crypto.randomUUID(), {
				x: 400,
				y: 430,
				w: 240,
				h: 130,
				iw: 1200,
				ih: 650,
				mime: "image/png",
				image: "0".repeat(64),
				alt: "The old logo, retired in 2025",
			});
		});
		doc.transact(() => {
			const shapes = doc.getMap<Y.Map<unknown>>("shapes");
			// Into the moodboard, and Tack's mark with its caption.
			placeInSections(
				doc,
				[...shapes.keys()].filter((id) => !before.has(id)),
			);
			for (const shape of shapes.values()) {
				if (shape.get("image") === mark.hash) shape.set("caption", true);
			}
		});
	})();
}

/** Every state an image can be in, for /play/cards. */
export function ImageGallery() {
	const [mark, setMark] = useState<{ url: string; preview?: string } | null>(null);
	useEffect(() => {
		let url = "";
		void tackMark().then((image) => {
			url = URL.createObjectURL(image.blob);
			setMark({ url, preview: image.preview });
		});
		return () => URL.revokeObjectURL(url);
	}, []);
	const states: {
		caption: string;
		state: ImageState;
		src: string | null | undefined;
		progress?: number;
		selected?: boolean;
		shape?: { alt?: string; caption?: boolean; upload?: boolean; preview?: boolean };
	}[] = [
		{ caption: "An image", state: "ready", src: mark?.url },
		{ caption: "Selected", state: "ready", src: mark?.url, selected: true },
		{
			caption: "With its caption",
			state: "ready",
			src: mark?.url,
			shape: { alt: "Tack’s mark", caption: true },
		},
		{ caption: "Loading", state: "ready", src: undefined },
		{ caption: "Uploading, yours", state: "uploading", src: mark?.url, progress: 0.42 },
		{
			caption: "Uploading, someone else’s",
			state: "uploading",
			src: null,
			shape: { upload: true, preview: true },
		},
		{ caption: "Upload abandoned", state: "interrupted", src: null, shape: { upload: true } },
		{
			caption: "Missing",
			state: "missing",
			src: null,
			shape: { alt: "The old logo, retired in 2025" },
		},
	];
	return (
		<section>
			<h2>Images</h2>
			<div className="gallery-grid gallery-images">
				{states.map(({ caption, state, src, progress, selected, shape = {} }) => (
					<figure key={caption} data-state={state}>
						<div className="gallery-image">
							<ImageView
								shape={{
									alt: shape.alt,
									caption: shape.caption,
									preview: shape.preview ? mark?.preview : undefined,
									upload: shape.upload
										? { by: PRIYA, client: -1, at: new Date().toISOString() }
										: undefined,
								}}
								state={state}
								src={src}
								progress={progress ?? null}
								selected={selected}
							/>
						</div>
						<figcaption>{caption}</figcaption>
					</figure>
				))}
			</div>
		</section>
	);
}
