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

	await menu.getByRole("menuitem", { name: "Sign out" }).click();
	await expect(page.getByRole("button", { name: "You (guest)" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Account: e2e-octocat" })).toHaveCount(0);
});
