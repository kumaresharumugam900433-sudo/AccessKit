# AccessKit URL accessibility scanner

An editable prototype for a URL-first accessibility scanning SaaS. Visitors enter a public URL; the backend opens the rendered page and checks computed styles and DOM. The prototype now includes account registration/sign-in, protected URL scanning, recurring pricing tiers, Razorpay subscription checkout, and subscription cancellation at the end of the current billing cycle.

The dashboard offers URL and pasted-HTML scan tabs, an accessible severity pie chart, a heuristic 0–100 health score, and keyboard-operable result tabs for **Confirmed violations**, **Needs review**, and **Manual check**. Signed-in users can create workspaces and keep URL and snippet scan history and findings scoped to the selected workspace. “Confirmed” indicates an automated rule match, not a conformance determination. Score deductions are 12 per critical, 6 per high, and 2 per low automated finding; manual prompts do not affect the score.

## Plans

The initial prices are configured in INR:

- ₹99 monthly, billed every month.
- ₹499 for six months, billed every six months.
- ₹999 for twelve months, billed yearly.

These are recurring Razorpay subscriptions. Users can schedule cancellation from the app; access remains governed by the provider's active subscription state.

## What the scanner checks

- WCAG 2.2 AA text contrast thresholds: 4.5:1 for normal text and 3:1 for large text.
- 3:1 contrast for some rendered control boundaries and SVG graphics.
- Potentially unnamed controls and custom interactive controls that may not be keyboard reachable.
- A manual keyboard flow review prompt.

These are automated heuristics, not a complete WCAG audit or conformance certification. Manual keyboard, screen reader, and assistive technology testing is still needed.

## Local development

Requires Node.js and local Chromium for Playwright:

```sh
npm install
npx playwright install chromium
npm start
```

Visit `http://127.0.0.1:4173`. Account records are stored in `data/accesskit.sqlite` by default. Set `DATA_DIR` to choose another directory.

Copy `.env.example` to `.env` and fill in the keys if you want to exercise Razorpay checkout locally. Never commit a populated `.env` file.

## Configure Razorpay subscriptions

Create three Razorpay subscription plans in the dashboard, using INR and these billing intervals:

| Plan | Amount | Period | Interval |
| --- | ---: | --- | ---: |
| Monthly | ₹99 | monthly | 1 |
| 6 months | ₹499 | monthly | 6 |
| 12 months | ₹999 | yearly | 1 |

Set the returned plan IDs and API credentials as server environment variables:

```text
RAZORPAY_KEY_ID=...
RAZORPAY_KEY_SECRET=...
RAZORPAY_PLAN_MONTHLY=plan_...
RAZORPAY_PLAN_6_MONTHS=plan_...
RAZORPAY_PLAN_YEARLY=plan_...
RAZORPAY_WEBHOOK_SECRET=...
```

Configure the Razorpay webhook URL as `https://YOUR_DOMAIN/api/billing/webhook` and subscribe to the events `subscription.activated`, `subscription.charged`, `subscription.resumed`, `subscription.cancelled`, `subscription.halted`, `subscription.paused`, and `subscription.completed`. Webhook signatures and subscription checkout signatures are verified server-side. Razorpay's public key ID is exposed to the checkout; the API secret and webhook secret stay on the server.

## Deploy

Deploy this folder as a Node web service with build command `npm install` and start command `npm start`. Set `HOST=0.0.0.0`, the Razorpay variables above, and `BROWSERLESS_WS_ENDPOINT` in the service's secret settings. `PORT` is read from the hosting provider environment. Set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` when using a remote browser service. The browser endpoint must use Playwright's native protocol, such as Browserless `/chromium/playwright`, because this scanner uses `page.route()` to filter requests.

The SQLite database must be on persistent storage. On Render, attach a persistent disk and set `DATA_DIR` to its mount path (for example, `/var/data`). Render's default filesystem is ephemeral, and persistent disks are only available on paid web services. For a production multi-instance deployment, move user/session/subscription data to a managed database instead of SQLite.

## Security and account limitations

This is still a prototype. It stores passwords as salted scrypt hashes and uses HttpOnly, SameSite session cookies, but it does not yet provide email verification, password reset, account recovery, admin controls, or robust rate limiting. Workspace and scan history are stored in SQLite alongside account data. The scanner also needs production-grade network egress controls against SSRF and DNS rebinding before public launch. Add those protections and test payment/webhook behavior in Razorpay test mode before enabling live charges.

## Customize

- `index.html`: dashboard, URL and snippet scan tabs, workspace controls, scan history, account dialog, pricing, findings, and JSON report export.
- `server.js`: authentication, sessions, workspace and scan-history APIs, subscription API, webhook handling, URL validation, browser lifecycle, and `/api/scan`.
- `extension/`: optional user-consented browser-extension scanning prototype.

Automated findings are a subset of WCAG checks. ARIA APG patterns are implementation guidance, not independent WCAG pass/fail criteria.
