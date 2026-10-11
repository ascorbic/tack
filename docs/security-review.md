# Security review

The security review (#60, M5): what was checked, what was found and fixed, how it's kept fixed, and what's left. Who may use each route and board message is the access table in AGENTS.md ("Access table"); what code has to keep doing is AGENTS.md's "Security".

## What was checked

- **Every route and board message**, for who may use it: a table of them all (AGENTS.md), checked by `test/access-table.test.ts` with seven kinds of people, from a stranger to an admin.
- **Headers**: what every response the Worker and the static assets send, and whether the app, the dev server, embeds, link previews, GitHub avatars, backlink snapshots and exported images still work under the policy, in a browser, on both the dev server and the built app (`vp preview`, which applies `_headers` as production does).
- **Cross-site requests** (CSRF and cross-site WebSockets), cookies and sessions, sign-in redirects.
- **Content from other people** wherever it's rendered: the document (any editor writes it), card data from the forge, comments, presence, Markdown in previews, the embed renderer and link preview tags.
- **Webhooks**: signatures, and what someone holding a captured delivery could do with it.
- **Server-side requests**: every `fetch` the Worker and its objects make, and whether anything a person types reaches a URL or an API path.
- **Abuse of the live connection** by people allowed on it, strangers on public boards included.

## What was found, and fixed

Most severe first.

**Script from a sign-in link** (high). The `/signin` page returned people to `return_to` with `location.replace`, unchecked, so `/signin?return_to=javascript:…` ran script on Tack's origin for anyone signed in who followed it, and `https://evil.example` was an open redirect. The server's own check could also be passed with a tab or newline (`/\t/evil.example`, which browsers read as `//evil.example`). Both now use one check (`safeReturnTo` in `src/shared/returnTo.ts`): a path on this site, with no control characters, spaces or backslashes, that still resolves to this origin.

**No security headers** (high, as defence in depth). Nothing set a CSP, `X-Frame-Options`, `nosniff` or HSTS, so the app could be framed (clickjacking: a push or an invite is a couple of clicks) and any script injection would have had free rein. Now every response has them (`src/server/securityHeaders.ts`): the Worker's from `withSecurityHeaders`, the static assets' from a `_headers` file the build writes. The app's policy allows scripts only from the app itself and the inline theme script by hash, and nothing may frame it. Testing it in the browser found three things the policy had to allow without weakening it: board pages (`/b/*`) come through the Worker for link previews and were getting the API's policy, which loads nothing (they now get the app's, with the hashes of the inline scripts actually on the page, so the dev server's page works as well); modern-screenshot sets a `<base>` to resolve the stylesheet's fonts, so `base-uri` is `'self'` rather than `'none'`; and avatars at `github.com/{login}.png` redirect to the avatars host, which snapshots fetch.

**Anyone could be anyone in presence** (high). Awareness (cursors, the people list, who's following whom, history's attribution) was relayed exactly as each client sent it, so any connection, a signed-out visitor to a public board included, could claim another person's login, name and avatar, rewrite or remove other people's cursors, and send states of any size. The timer's and spotlight's credits ("Kai stopped the timer") also came from the client. Now every awareness update is checked (`src/server/awareness.ts`): signed-in people are who their sign-in says, guests carry no login or picture, a connection can only speak for its own client ids (at most four), and states are at most 32 KB.

**Webhook replays** (medium). Only a delivery's body is signed: its id and event name are headers anyone holding a captured delivery can change. Deliveries were deduplicated by id alone, and installation events not at all, so a replayed body under a new id was processed again, and a replayed body of another event sent as `installation` could have changed what Tack thought was installed. Now deliveries are told apart by the SHA-256 of the signed body as well (the `Repo` keeps both for three days, the `Instance` installation events' for 30), an installation event only counts if its body is one, and comment commands written more than a week ago are ignored (`stale`). Older payloads never overwrite newer card data anyway, and rules never place an item twice, so a replay past those windows changes nothing.

**API paths from the document** (medium). Card keys come from the document, which any editor writes, and their repository part went into API paths (`/repos/{owner}/{repo}/…`) requested with the viewer's token or the app's. A name with `..` or `?` could have pointed one of those requests at another endpoint. Repository paths must now be plain segments (`isRepoPath` in `src/shared/refs.ts`; `parseKey` and `parseRepoKey` refuse anything else), and the GitHub adapter's own pattern refuses `.` and `..`. Other user-supplied parts of paths (branches, folders) were already encoded segment by segment.

**The app's JWT could follow a link** (medium). The redelivery cron followed GitHub's `Link` header for pagination wherever it pointed, with the app's JWT. It now only follows links to GitHub's API.

**Cross-site checks were per route** (medium). Most routes that change state checked `Origin`, but not all did, and live connections didn't at all (SameSite=Lax keeps the session cookie off cross-site WebSocket handshakes in today's browsers, but that's the browser's choice). Now the Worker turns away every state change and every live connection from another site before any route sees it; webhooks, which are signed, are the one exception.

**`javascript:` links** (medium). Links that come from the document (a comment command's provenance link, an action item's issue link, a push result's URL, a credit's board URL) and from the forge (cards, CI checks, whatever app posted them, releases, pushes' items) were rendered as `href` as they were. They all go through `safeUrl` now, which keeps only http(s); `window.open` for cards too.

**Strangers saw who's on a public board** (low). `GET /api/boards/:id/members` answered signed-out visitors to public boards with every member and invite. They now need to sign in. They still get the members as people who can be mentioned (`/people`), to show mentions in comments by name, as #56 decided, but not recent visitors.

**Presence could fill a board's memory** (low). A connection could invent thousands of presence clients, each a 32 KB state, and the board's object kept them all. Past four per connection, new ones are dropped.

**Imports were read before they were allowed** (low). `POST /api/boards/import` parsed up to 4 MB of JSON before checking the person may make boards. It checks first now.

**Rate limits were handled differently everywhere** (reliability, and how well Tack behaves towards GitHub). Each adapter read GitHub's limits its own way; polling took any error's reset header as a reason to wait; comment command replies didn't wait at all; and once GitHub said a token was limited, other code kept calling with it. Now every GitHub call goes through `forgeFetch` (`src/server/forges/rateLimit.ts`), which notes primary and secondary limits per token (hashed) and resource, answers for GitHub while one holds, and escalates repeated secondary limits; everything reads limits the same way (`rateLimitOf`) and waits for the same `retryAt`.

## Checked, and fine

- **Sessions**: a random id in a signed, `HttpOnly`, `SameSite=Lax` cookie (`Secure` over HTTPS); only its hash is stored, and sign-in makes a new one. GitHub tokens are encrypted at rest with keys derived from `TACK_SECRET`, refreshed with rotation, and never sent to the browser. OAuth uses state and PKCE. Dev sign-in is only declared in development and only answers on loopback hosts.
- **Rendering**: React escapes everything, and nothing renders HTML from content (the one `innerHTML` is a fixed placeholder in snapshots). Markdown previews build React elements and keep only http(s) links and images. The embed renderer draws text as paths (Satori), and link preview tags escape what they carry. Comment command replies defuse mentions, links and Markdown in what they quote.
- **Server-side requests**: the Worker and its objects only call forge APIs at fixed hosts (`api.github.com`, `github.com` for OAuth) and its own objects. Nothing fetches a URL someone typed: embeds draw from the board's data with bundled fonts and no images, and snapshots are uploaded, never fetched. So there's no SSRF to fix; the API path findings above are the nearest thing.
- **Board data**: per-viewer card filtering, the redacted push log, public boards' anonymous view (`test/public-boards.test.ts`), silent mode's text never in the document, history or anyone else's messages (`test/facilitation-board.test.ts`, `test/history-board.test.ts`), and embeds only for public boards were all re-checked and hold.
- **Viewers' writes**: y-partyserver drops document updates from read-only connections, and every custom message that changes something checks the role (the table).

## What's left

- **Editors are trusted with the whole document.** Anyone who can edit can write any key in it, including ones the server usually writes: push statuses (cosmetic: SQLite decides what's pushed), the timer, a vote's state (`VoteGuard` puts wrong ones right), silent marks (`SilentHub.reconcile` does the same) and rules (which only place items from repositories already on the board, with data from deliveries). Making the document enforce per-key permissions would mean filtering Yjs updates by what they touch, which is a large change for people who are already trusted to edit the board.
- **Staged changes are pushed by whoever presses Push**, as them, including changes another editor staged. The push sheet shows every change and who staged it before anything goes, so this is a review step rather than a hole; it's worth knowing on boards with many editors.
- **`style-src 'unsafe-inline'`.** React Flow positions every node with a `style` attribute and snapshots clone the canvas with its styles, so hashes can't cover them. Injected CSS can't run script, and nothing renders HTML from content.
- **Images from any HTTPS host.** `img-src https:` is what lets Markdown previews show images people linked in issue bodies, and avatars from anywhere GitHub serves them. An editor could put a tracking image in a staged issue's body, which loads when someone previews it.
- **The rate-limit gate is per isolate.** Each Worker isolate and Durable Object keeps its own, so a limit one has seen isn't known to the others until they see it too. Every response still carries GitHub's headers, so each learns on its first call; sharing it (say, through the `Instance`) would cost a round trip on every GitHub call.
- **Custom messages from people on a board aren't rate limited** beyond comments (per connection) and widget refreshes and rechecks (throttled). A connection can send `since-request` or `clock` as fast as it likes, but that only costs its own board's object, which is what it's connected to anyway.
- **The session cookie isn't `__Host-` prefixed.** It's host-only already (no `Domain`), so the prefix would add little, and renaming it would sign everyone out.
- **Backups to a public repository** of a board that isn't public are allowed, with a warning in the dialog; cards from other repositories that aren't public are left out of every backup, as are face-down stickies. The owner chooses where their board goes.
