---
title: Email
description: Letting an instance send weekly digests by email, through Cloudflare Email Service.
sidebar:
  order: 5
---

Tack sends one kind of email: [weekly digests](/facilitation/weekly-digests/), and the confirmation that comes first. It's off until you set it up, and everything else works without it: boards can still post their digests as GitHub Discussions.

Email goes out through [Cloudflare Email Service](https://developers.cloudflare.com/email-service/), from a domain on your Cloudflare account.

## Setting it up

1. In the Cloudflare dashboard, open **Email Service** and onboard a domain for sending, on the same account as Tack. Cloudflare adds the DNS records sending needs (SPF and DKIM). Use a subdomain, like `mail.example.com`, if your main domain already sends mail from elsewhere.
2. In your copy of Tack, set `EMAIL_FROM` at the top of `cloudflare.config.ts` to the address digests come from, on that domain:

   ```ts
   const EMAIL_FROM = "Tack <tack@mail.example.com>";
   ```

   This also adds the `send_email` binding (`TACK_EMAIL`) that sends it.

3. Run `pnpm run wrangler-config`, commit, and deploy.

Then **Weekly digest…** on a board offers **Email people who ask for it**. Until then, it says "This Tack can't send email yet".

## What it sends

- **A confirmation**, when someone asks for a board's digest from the board: a link to confirm the address, good for a week. Nothing else goes until it's followed. Someone can ask again after ten minutes, a board sends at most twenty an hour, and at most 200 people get each board's digest.
- **The digest**, once a week, as HTML and plain text, with no images or tracking. Each has a link to stop and the `List-Unsubscribe` headers mail apps use for their own unsubscribe button.

Only people allowed on the instance can ask, and only for boards they can open. An address that bounced or complained before (suppressed by Email Service) is unsubscribed.

## When it doesn't go

**Recent digests** in the board's dialog, and the logs (`digest.email.failed`, with Email Service's code), say why:

| Code                            | What to do                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `E_SENDER_NOT_VERIFIED`         | `EMAIL_FROM` isn't on the domain you onboarded                                    |
| `E_SENDER_DOMAIN_NOT_AVAILABLE` | The domain isn't onboarded for sending yet, or its DNS records aren't in place    |
| `E_RATE_LIMIT_EXCEEDED`         | Sending too fast: Tack tries again in 15 minutes                                  |
| `E_DAILY_LIMIT_EXCEEDED`        | The account's daily limit is used up: Tack tries again later                      |
| `E_RECIPIENT_SUPPRESSED`        | The address bounced or complained before: they're unsubscribed, and can ask again |

## Local development

The dev server always has email on, from `tack@example.com`. Nothing leaves your machine.
