This file provides guidance to agentic coding tools when working with code in this repository.

## ⚠️ Template Setup Required

**This is currently a template repository.** If you see this message, check if this is a new repo based on the template, by seeing if the git remote is ascorbic/worker-template. If not, you need to set up a new project by updating the following:

1. **Worker name**: Update `name` in `cloudflare.config.ts` and `package.json` to your new Worker name
2. **README**: Update README.md with your project information
3. **Test files**: Update the greeting strings in `src/index.ts` and `test/index.test.ts`, and rename the test file if appropriate
4. **Workers Builds**: Deploys run on Cloudflare's [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), not GitHub Actions. Tell the user to connect the repository in the Cloudflare dashboard (Worker → **Settings** → **Build**), leaving the build command empty and setting the deploy command to `pnpm run deploy` (`cf deploy` builds and deploys in one step).

5. **GitHub Secrets**: For `CLAUDE_CODE_OAUTH_TOKEN` (used by claude.yml): Tell the user to open Claude Code and run the `/install-github-app` command, which will guide them through setting up the GitHub app and automatically add the secret to their repository. Note: The user must be a repository admin to install the GitHub app and add secrets.

6. **Repository Settings and Branch Protection**: Configure repository settings and branch protection rules using the GitHub CLI. Get the current repository name first:

   ```bash
   # Get repository name (format: owner/repo)
   REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

   # Configure repository settings
   gh api repos/$REPO --method PATCH \
     -f allow_squash_merge=true \
     -f allow_merge_commit=false \
     -f allow_rebase_merge=false \
     -f delete_branch_on_merge=true \
     -f allow_auto_merge=true \
     -f allow_update_branch=true \
     -f squash_merge_commit_message=COMMIT_MESSAGES \
     -f squash_merge_commit_title=COMMIT_OR_PR_TITLE \
     -f has_wiki=false

   # Create branch protection ruleset for main branch
   gh api repos/$REPO/rulesets --method POST --input - <<'EOF'
   {
     "name": "main",
     "target": "branch",
     "enforcement": "active",
     "conditions": {
       "ref_name": {
         "include": ["~DEFAULT_BRANCH"],
         "exclude": []
       }
     },
     "rules": [
       {"type": "deletion"},
       {"type": "non_fast_forward"},
       {"type": "required_linear_history"},
       {
         "type": "pull_request",
         "parameters": {
           "required_approving_review_count": 0,
           "dismiss_stale_reviews_on_push": false,
           "require_code_owner_review": false,
           "require_last_push_approval": false,
           "required_review_thread_resolution": false,
           "allowed_merge_methods": ["merge", "squash", "rebase"]
         }
       },
       {
         "type": "required_status_checks",
         "parameters": {
           "strict_required_status_checks_policy": true,
           "do_not_enforce_on_create": true,
           "required_status_checks": [
             {"context": "test"},
             {"context": "Validate PR title"}
           ]
         }
       }
     ],
     "bypass_actors": [
       {"actor_type": "RepositoryRole", "actor_id": 5, "bypass_mode": "always"}
     ]
   }
   EOF
   ```

After setup, remove this section from AGENTS.md.

## Repository Structure

A standalone Cloudflare Worker built with Vite+ and the Cloudflare Vite plugin.

- `src/index.ts` — the Worker entrypoint
- `test/` — Vitest tests, run inside workerd via `@cloudflare/vitest-plugin`
- `cloudflare.config.ts` — Worker configuration (the experimental `cf`-CLI-native format; there is no wrangler.jsonc)
- `compatibility.ts` — compatibility date/flags, shared between the Worker config and the test runtime
- `vite.config.ts` — unified Vite+ config: Vite plugins, Vitest, oxlint, and oxfmt
- `worker-configuration.d.ts` — generated types; committed. Regenerated automatically while `pnpm dev` runs

## Commands

- `pnpm dev` — start the dev server (`vp dev`; `cf dev` also works and delegates to it)
- `pnpm test` — run tests in the Workers runtime
- `pnpm check` — format check, lint, and type check in one pass (`vp check`)
- `pnpm fix` — apply formatting and safe lint fixes
- `pnpm build` — production build
- `pnpm deploy` — build and deploy (`cf deploy`; requires `cf auth login` or `CLOUDFLARE_API_TOKEN`). Production deploys normally happen via Workers Builds on push to main, not from CI or local machines

## Configuration Architecture

- **`cloudflare.config.ts` is the source of truth for the Worker**: name, entrypoint, compatibility, bindings, observability. It uses the experimental new config format (`experimental.newConfig` in the Vite plugin), which both the `cf` CLI and plain `vp`/Vite commands read. `defineWorker` is imported from `@cloudflare/vite-plugin/experimental-config` — do not import it from `@cloudflare/config` directly, or the generated types stop resolving (the two packages carry different unique symbols).
- The entrypoint uses the `with { type: "cf-worker" }` import attribute. This is what makes `Env` and `exports` inference work — keep that form when changing the entrypoint.
- **Bindings**: declare them in `cloudflare.config.ts` (e.g. `env: { MY_KV: bindings.kv() }` with `bindings` from the same import). The `Env` type in `worker-configuration.d.ts` is inferred from them — run `pnpm dev` briefly after config changes to regenerate it, and commit the result.
- **`compatibility.ts`** exists so the Vitest runtime (`cloudflareTest` in vite.config.ts) always matches the deployed runtime. Extra exports are not allowed in `cloudflare.config.ts` (its exports are schema-validated), which is why this is a separate file.
- **Version pins that must move together**: the `vitest` devDependency and the `vitest` override in `pnpm-workspace.yaml` are pinned to the version bundled by vite-plus (check with `pnpm exec vp toolchain`). `vite` is aliased to `@voidzero-dev/vite-plus-core` (as a devDependency and an override) so every package resolves the same Vite — do not add a real `vite` dependency.

## Testing

- Tests run inside workerd. Import test APIs from `cloudflare:workers` (`env`, `exports`) — `exports.default.fetch()` replaces the deprecated `SELF`, and `env` from `cloudflare:test` is also deprecated.
- `test/env.d.ts` wires the `ProvidedEnv` type to the generated `Env`.
- For integration tests against the production build, use `createTestHarness()` from `wrangler` pointed at the built output (`dist/<worker_name>/wrangler.json` after `pnpm build`).

## Development Workflow

- Uses **pnpm**, wrapped by **Vite+** (`vp`). Format and lint are oxfmt/oxlint via `vp check` — there is no prettier or eslint. Type checking runs inside `vp check` (tsgolint with `typeAware`/`typeCheck` enabled).
- Formatting uses tabs (configured in `vite.config.ts` under `fmt`).
- CI (test.yml) runs `vp check`, `vp test`, and `vp build` via the `voidzero-dev/setup-vp` action.
