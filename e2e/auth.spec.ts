import { expect, test } from "./fixtures.ts";

// Sign-in UI. The dev server runs with TACK_SECRET and TACK_DEV_AUTH (see
// playwright.config.ts), so /auth/dev signs in a fake user without GitHub.

test.beforeEach(async ({ page }) => {
	// Keep the tests hermetic: GitHub avatars fail to load, and fall back to initials.
	await page.route("https://github.com/**", (route) => route.abort());
});

test("every sign-in, access and setup state renders", async ({ page }) => {
	await page.goto("/play/auth");
	const guest = page
		.locator("figure")
		.filter({ has: page.locator("figcaption", { hasText: /^Guest$/ }) });
	await expect(guest.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
	await expect(guest.getByRole("menuitem", { name: "Sign in with GitHub" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "This Tack is invite-only" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Set up Tack" }).first()).toBeVisible();
	await expect(page.getByRole("group", { name: "Admins" }).last()).toBeVisible();

	// Where the app is installed, and whether it can push there.
	const installed = page.locator("figure").filter({
		has: page.locator("figcaption", { hasText: "Installed: one read-only, one suspended" }),
	});
	await expect(installed.getByRole("heading", { name: "Where it’s installed" })).toBeVisible();
	await expect(installed.locator(".installs-list .install")).toHaveCount(3);
	await expect(installed.locator(".installs-list .install[data-tone=ok]")).toContainText("Live · Tack can push");
	await expect(installed.locator(".installs-list .install[data-tone=warn]")).toContainText("Live, read-only");
	await expect(installed.getByRole("img", { name: "Private" })).toHaveCount(1);
	const fresh = page
		.locator("figure")
		.filter({ has: page.locator("figcaption", { hasText: /^Just created$/ }) });
	await expect(fresh.getByText("It isn’t installed anywhere yet.")).toBeVisible();
	const down = page.locator("figure").filter({
		has: page.locator("figcaption", { hasText: "Installed, GitHub unreachable" }),
	});
	await expect(down.getByRole("alert")).toContainText("Couldn’t ask GitHub");
	// Repositories on boards that the app isn't on.
	const missing = installed.getByRole("region", { name: "On boards, without the app" });
	await expect(missing.getByRole("listitem")).toHaveText(["withastro/astro", "acme/new"]);
});

test("the setup checklist says where an instance stands, and what to do next", async ({ page }) => {
	await page.goto("/play/auth");
	const figure = (caption: string) =>
		page.locator("figure").filter({ has: page.locator("figcaption", { hasText: caption }) });

	// No secret: one made in the browser, ready to copy.
	const secret = figure("No TACK_SECRET");
	const checklist = secret.getByRole("navigation", { name: "Setup checklist" });
	await expect(checklist).toContainText("0 of 5 done");
	await expect(checklist.locator("[aria-current=step]")).toContainText("Secret");
	await expect(secret.getByLabel("A new secret")).toHaveText(/^[A-Za-z0-9+/]{43}=$/);
	await expect(secret.getByRole("button", { name: "I’ve set it: check again" })).toBeVisible();

	// Everything done.
	const done = figure("All set").getByRole("navigation", { name: "Setup checklist" });
	await expect(done).toContainText("All set");
	await expect(done.locator("[data-tone=done]")).toHaveCount(5);

	// Webhooks refused: the checklist points at them, and says how to fix it.
	const refused = figure("Webhooks refused");
	await expect(refused.locator("[aria-current=step]")).toContainText("Webhooks");
	const webhooks = refused.getByRole("region", { name: "Webhooks" });
	await expect(webhooks).toContainText("Refused");
	await expect(webhooks).toContainText("GITHUB_WEBHOOK_SECRET");
	await expect(webhooks.getByRole("link", { name: "App settings" })).toBeVisible();
	await expect(figure("Webhooks going elsewhere")).toContainText("tack.ascorbic.workers.dev");
	await expect(figure("Running locally")).toContainText("Off while local");
});

test("dev sign-in shows who you are, and signing out makes you a guest", async ({ page }) => {
	await page.goto(
		`/auth/dev?login=e2e-octocat&name=E2E%20Octocat&return_to=${encodeURIComponent("/?board=e2e-auth")}`,
	);
	// Boards from before the index redirect to their new address.
	await expect(page).toHaveURL(/\/b\/e2e-auth\/e2e-auth$/);

	const account = page.getByRole("button", { name: "Account: e2e-octocat" });
	await expect(account).toBeVisible();
	await account.click();
	const menu = page.getByRole("menu");
	await expect(menu).toContainText("E2E Octocat");
	await expect(menu).toContainText("@e2e-octocat");

	// Theme lives in the account menu, not the top bar.
	await expect(menu.getByRole("radiogroup", { name: "Theme" })).toBeVisible();
	await expect(page.locator(".topbar .theme-switch")).toHaveCount(0);

	await menu.getByRole("menuitem", { name: "Sign out" }).click();
	await expect(page.getByRole("button", { name: "You (guest)" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Account: e2e-octocat" })).toHaveCount(0);
	// And it says so.
	await expect(page.getByRole("status").filter({ hasText: "Signed out" })).toBeVisible();
});

// Routes the Worker handles must reach it rather than the static site's
// single-page fallback, which serves index.html for any unknown path. Each one
// needs an entry in `assets.runWorkerFirst` in cloudflare.config.ts.
for (const path of [
	"/setup/install?state=/b/demo/demo",
	"/setup/installed",
	"/setup/callback",
	"/auth/signin",
	"/api/me",
]) {
	test(`${path} is handled by the Worker, not the SPA`, async ({ request }) => {
		const response = await request.get(path, { maxRedirects: 0 });
		const body = await response.text();
		expect(body, `${path} served the SPA's index.html`).not.toContain('<div id="root">');
	});
}
