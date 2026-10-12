// The link preview images, drawn in a browser from the landing page's words,
// its sticky (src/hero.ts) and its board's screenshot: the site's,
// public/og.png (1200 × 630), and the repository's social preview,
// .github/social-preview.png (1280 × 640, GitHub's size; set it by hand in
// the repository's Settings → General → Social preview).
//
//   pnpm --filter site og
//
// Run it again after retaking the screenshots. Install the browser once with
// `pnpm exec playwright install chromium`.
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { HERO_STICKY } from "../src/hero.ts";

const root = path.resolve(import.meta.dirname, "..");
const IMAGES = [
	{ out: path.join(root, "public/og.png"), width: 1200, height: 630, foot: "tack.social" },
	{
		out: path.join(root, "../.github/social-preview.png"),
		width: 1280,
		height: 640,
		foot: "Free · Open source · Self-hosted · tack.social",
	},
];
// Fonts and the board go in as data, since the page has no address to load them from.
const font = async (pkg: string, file: string) =>
	`data:font/woff2;base64,${(
		await readFile(path.join(root, "node_modules/@fontsource-variable", pkg, "files", file))
	).toString("base64")}`;
const display = await font("bricolage-grotesque", "bricolage-grotesque-latin-wght-normal.woff2");
const ui = await font("geist", "geist-latin-wght-normal.woff2");
const board = await readFile(path.join(root, "src/assets/screenshots/hero-light.webp"));

const page = ({ width, height, foot }: (typeof IMAGES)[number]) => {
	// Wider than the site's: the same picture, given the extra room evenly.
	const dx = (width - 1200) / 2;
	const dy = (height - 630) / 2;
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
	@font-face {
		font-family: "Bricolage";
		src: url("${display}") format("woff2");
		font-weight: 200 800;
	}
	@font-face {
		font-family: "Geist";
		src: url("${ui}") format("woff2");
		font-weight: 100 900;
	}
	* { box-sizing: border-box; margin: 0; }
	html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
	body {
		position: relative;
		background:
			radial-gradient(circle, #d3cfc5 1.2px, transparent 1.6px) 0 0 / 24px 24px,
			#f4f3ef;
		color: #17191c;
		font-family: "Geist", sans-serif;
	}
	.copy {
		position: absolute;
		left: ${72 + dx}px;
		top: ${64 + dy}px;
		width: 540px;
		display: flex;
		flex-direction: column;
		gap: 28px;
	}
	.brand { display: flex; align-items: center; gap: 12px; }
	.brand svg { width: 44px; height: 44px; overflow: visible; }
	.wordmark {
		font-family: "Bricolage", sans-serif;
		font-size: 40px;
		font-weight: 750;
		letter-spacing: -0.03em;
	}
	h1 {
		font-family: "Bricolage", sans-serif;
		font-size: 66px;
		font-weight: 760;
		line-height: 1.02;
		letter-spacing: -0.045em;
	}
	em {
		font-style: normal;
		background: linear-gradient(transparent 62%, rgb(255 210 92 / 75%) 62% 92%, transparent 92%);
		padding-inline: 0.05em;
	}
	p {
		font-size: 27px;
		line-height: 1.4;
		color: #3f444b;
	}
	.url {
		position: absolute;
		left: ${72 + dx}px;
		bottom: ${52 + dy}px;
		font-size: 24px;
		font-weight: 600;
		color: #3b4cca;
	}
	.board {
		position: absolute;
		left: ${640 + dx}px;
		top: ${92 + dy}px;
		width: 860px;
		border-radius: 16px;
		overflow: hidden;
		border: 1px solid rgb(23 25 28 / 16%);
		box-shadow: 0 4px 10px rgb(23 25 28 / 8%), 0 40px 80px -20px rgb(59 76 202 / 30%);
		transform: perspective(2400px) rotateY(-6deg) rotateX(2deg);
		transform-origin: left center;
	}
	.board img { display: block; width: 100%; }
	.sticky {
		position: absolute;
		left: ${600 + dx}px;
		top: ${390 + dy}px;
		width: 232px;
		padding: 22px 22px 20px;
		border-radius: 3px 3px 3px 16px;
		background: #ffe58f;
		box-shadow: 0 1px 1px rgb(0 0 0 / 6%), 0 18px 26px -12px rgb(0 0 0 / 30%);
		font-family: "Bricolage", sans-serif;
		font-size: 25px;
		font-weight: 650;
		line-height: 1.2;
		letter-spacing: -0.01em;
		transform: rotate(3deg);
	}
	/* The tack's head in the paper, as on the landing page's sticky. */
	.sticky .pin { position: absolute; top: 0; left: 50%; translate: -50% 0; }
	.sticky .pin svg { width: 40px; height: 40px; overflow: visible; }
	.sticky .who {
		margin-top: 14px;
		font-family: "Geist", sans-serif;
		font-size: 15px;
		font-weight: 600;
		opacity: 0.8;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.sticky .who i { width: 9px; height: 9px; border-radius: 50%; background: #b4467a; }
</style>
</head>
<body>
	<div class="board"><img src="data:image/webp;base64,${board.toString("base64")}" /></div>
	<div class="copy">
		<div class="brand">${mark(true)}<span class="wordmark">tack</span></div>
		<h1>Plan on a board.<br /><em>Sync</em> to GitHub.</h1>
		<p>A live, multiplayer whiteboard full of your real issues and pull requests.</p>
	</div>
	<div class="sticky">
		<span class="pin">${mark(false)}</span>
		${HERO_STICKY}
		<div class="who"><i></i>Priya</div>
	</div>
	<div class="url">${foot}</div>
</body>
</html>`;
};

/** The Tack mark (src/components/BrandMark.astro), or only its pin. */
function mark(note: boolean): string {
	return `<svg viewBox="0 0 24 24" aria-hidden="true">
		${
			note
				? `<g transform="rotate(-5 12 7)">
			<path d="M4.5 6.5h15v12.2l-3.3 3.3H4.5z" fill="#ffd85c" />
			<path d="M16.2 22v-3.3h3.3z" fill="#e8b93a" />
		</g>`
				: ""
		}
		<ellipse cx="12.6" cy="9.4" rx="3.1" ry="1.3" fill="rgb(0 0 0 / 18%)" />
		<circle cx="12" cy="7" r="3.4" fill="#e5533d" />
		<circle cx="10.9" cy="5.9" r="1.1" fill="rgb(255 255 255 / 55%)" />
	</svg>`;
}

const browser = await chromium.launch();
for (const image of IMAGES) {
	const tab = await browser.newPage({ viewport: { width: image.width, height: image.height } });
	await tab.setContent(page(image), { waitUntil: "load" });
	await tab.evaluate(() => document.fonts.ready);
	await tab.screenshot({ path: image.out });
	await tab.close();
	console.log(`Wrote ${path.relative(root, image.out)}`);
}
await browser.close();
