// Module types the Cloudflare Vite plugin bundles for the Worker: `.wasm` as
// compiled WebAssembly modules and `.bin` as raw bytes (render.ts).

declare module "*.wasm" {
	const module: WebAssembly.Module;
	export default module;
}

declare module "*.bin" {
	const data: ArrayBuffer;
	export default data;
}
