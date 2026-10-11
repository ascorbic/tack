// Colours for board images (#57), copied from the design tokens in
// src/client/styles.css, so an image of a board looks like the board in
// either theme. Keep the two in step when the tokens change.

import type { EmbedTheme } from "../../shared/embed.ts";

export interface Palette {
	ground: string;
	dots: string;
	surface: string;
	surfaceMuted: string;
	ink: string;
	inkSoft: string;
	muted: string;
	line: string;
	lineStrong: string;
	accent: string;
	chip: string;
	state: Record<"open" | "merged" | "closed" | "draft", { ink: string; bg: string }>;
	checks: Record<"passing" | "failing" | "pending", string>;
	sticky: Record<string, string>;
	stickyInk: string;
	stickyInkSoft: string;
	section: Record<string, { fill: string; edge: string; title: string; ink: string }>;
	connector: Record<string, string>;
	shadow: string;
	badge: { bg: string; ink: string; edge: string };
}

const LIGHT: Palette = {
	ground: "#f4f3ef",
	dots: "#d3cfc5",
	surface: "#ffffff",
	surfaceMuted: "#f7f6f2",
	ink: "#17191c",
	inkSoft: "#3f444b",
	muted: "#5a5f66",
	line: "rgba(23,25,28,0.09)",
	lineStrong: "rgba(23,25,28,0.16)",
	accent: "#3b4cca",
	chip: "#f1efea",
	state: {
		open: { ink: "#1a6431", bg: "#e3f4e7" },
		merged: { ink: "#6533b8", bg: "#f0e8fb" },
		closed: { ink: "#4a4f56", bg: "#ecebe4" },
		draft: { ink: "#4a4f56", bg: "#ecebe4" },
	},
	checks: { passing: "#1f883d", failing: "#cf222e", pending: "#d4a72c" },
	sticky: {
		yellow: "#ffe58f",
		pink: "#ffc9da",
		blue: "#c7ddff",
		green: "#c9efcf",
		purple: "#e2d4ff",
	},
	stickyInk: "rgba(23,25,28,0.9)",
	stickyInkSoft: "rgba(23,25,28,0.55)",
	section: {
		grey: {
			fill: "rgba(255,255,255,0.62)",
			edge: "rgba(23,25,28,0.13)",
			title: "#e8e6e0",
			ink: "#3f444b",
		},
		red: { fill: "rgba(253,232,228,0.72)", edge: "#f0b7ae", title: "#f8d3cc", ink: "#8f2a1d" },
		orange: { fill: "rgba(253,238,222,0.72)", edge: "#efc496", title: "#f8dbbb", ink: "#7d420e" },
		yellow: { fill: "rgba(252,245,214,0.75)", edge: "#e6d27a", title: "#f5e7a6", ink: "#66530c" },
		green: { fill: "rgba(229,245,232,0.75)", edge: "#a6d6af", title: "#cbead1", ink: "#1b5e2e" },
		blue: { fill: "rgba(229,238,253,0.75)", edge: "#a7c2ef", title: "#cddbf7", ink: "#23489a" },
		purple: { fill: "rgba(240,233,253,0.75)", edge: "#c6b0ee", title: "#e0d2f8", ink: "#5a2fa0" },
	},
	connector: {
		ink: "#3f444b",
		red: "#c2372b",
		orange: "#a8560c",
		green: "#1f7a4a",
		blue: "#2a62c9",
		purple: "#7444c4",
	},
	shadow: "0 1px 1px rgba(23,25,28,0.04), 0 2px 6px rgba(23,25,28,0.05)",
	badge: { bg: "rgba(255,255,255,0.92)", ink: "#17191c", edge: "rgba(23,25,28,0.12)" },
};

const DARK: Palette = {
	ground: "#141518",
	dots: "#34363c",
	surface: "#1f2125",
	surfaceMuted: "#1a1c1f",
	ink: "#eceef1",
	inkSoft: "#c9cdd3",
	muted: "#a0a6ae",
	line: "rgba(255,255,255,0.08)",
	lineStrong: "rgba(255,255,255,0.15)",
	accent: "#95a0ff",
	chip: "#2b2e33",
	state: {
		open: { ink: "#6fd38a", bg: "#183323" },
		merged: { ink: "#bfa2ff", bg: "#2b2342" },
		closed: { ink: "#b3b8bf", bg: "#2b2d32" },
		draft: { ink: "#b3b8bf", bg: "#2b2d32" },
	},
	checks: { passing: "#3fb950", failing: "#f0524a", pending: "#d29922" },
	sticky: {
		yellow: "#f2d77c",
		pink: "#f2b7ca",
		blue: "#b4cbf2",
		green: "#b6deba",
		purple: "#d0c1f3",
	},
	stickyInk: "rgba(23,25,28,0.9)",
	stickyInkSoft: "rgba(23,25,28,0.55)",
	section: {
		grey: {
			fill: "rgba(255,255,255,0.04)",
			edge: "rgba(255,255,255,0.14)",
			title: "#2c2f34",
			ink: "#d4d8de",
		},
		red: { fill: "rgba(240,82,74,0.09)", edge: "#6b3430", title: "#45231f", ink: "#ffb3aa" },
		orange: { fill: "rgba(230,140,60,0.09)", edge: "#6b4626", title: "#43301c", ink: "#f5c38f" },
		yellow: { fill: "rgba(230,200,80,0.08)", edge: "#635623", title: "#3d3519", ink: "#ecd77e" },
		green: { fill: "rgba(80,190,110,0.08)", edge: "#2f5c3b", title: "#1f3a27", ink: "#9fdcae" },
		blue: { fill: "rgba(100,140,240,0.09)", edge: "#34497a", title: "#222f4d", ink: "#adc4f5" },
		purple: { fill: "rgba(160,120,240,0.09)", edge: "#4d3d7a", title: "#30264a", ink: "#cdb8f7" },
	},
	connector: {
		ink: "#c9cdd3",
		red: "#ff8a7d",
		orange: "#f2a65a",
		green: "#6fd38a",
		blue: "#8fb0ff",
		purple: "#bfa2ff",
	},
	shadow: "0 1px 1px rgba(0,0,0,0.3), 0 2px 6px rgba(0,0,0,0.22)",
	badge: { bg: "rgba(31,33,37,0.92)", ink: "#eceef1", edge: "rgba(255,255,255,0.14)" },
};

export function palette(theme: EmbedTheme): Palette {
	return theme === "dark" ? DARK : LIGHT;
}
