# Shock Surplus Dashboard

Internal sales reporting dashboard. Pulls orders and draft orders directly from Shopify via GraphQL, caches completed months, and renders live charts and tables for rep performance.

## Files

```
ss-dashboard/
├── api/
│   ├── _shopify.js         (shared Shopify auth + token cache)
│   ├── _auth.js            (admin + dashboard auth helpers)
│   ├── orders.js           (Shopify orders endpoint, per-month, cached)
│   ├── draft-orders.js     (Shopify draft orders endpoint, per-month, cached)
│   ├── clear-cache.js      (admin: list/clear cached months)
│   └── login.js            (dashboard password check)
├── public/
│   └── index.html          (frontend — single file, loads Bebas Neue / Inter + Chart.js from CDNs)
├── package.json
└── vercel.json
```

## Deploy to Vercel

1. Import the project in Vercel (or run `vercel` in the folder).
2. Add environment variables (see below).
3. Deploy (`vercel --prod`).
4. Visit the URL Vercel gives you.

## Environment variables

| Name                    | Required | Purpose                                                              |
|-------------------------|----------|----------------------------------------------------------------------|
| `SHOPIFY_CLIENT_ID`     | yes      | Shopify app client ID                                                |
| `SHOPIFY_CLIENT_SECRET` | yes      | Shopify app client secret                                            |
| `SHOPIFY_STORE`         | yes      | Store handle, e.g. `shock-surplus`                                   |
| `DASHBOARD_PASSWORD`    | optional | If set, users must enter this password to view the dashboard         |
| `ADMIN_KEY`             | yes (for cache UI) | Separate key required to list or clear cached months       |
| `BLOB_READ_WRITE_TOKEN` | yes      | Vercel Blob token (auto-provisioned when you add Blob storage)       |

## Shopify scopes required

- `read_orders`
- `read_draft_orders`
- `read_products`

## How the data layer works

Each month is fetched via Shopify GraphQL with cursor pagination. Orders page at 40 per page × 20 line items — comfortably under Shopify's 1,000-point query-cost cap. Drafts page at 50 per page × 20 line items.

**Three cache tiers:**

- **Vercel Blob (persistent, per month)** — completed months are cached as `orders-YYYY-MM.json` and `drafts-YYYY-MM.json`. Next load is instant, no Shopify calls.
- **In-browser session cache** — the current month is cached in memory within a browser tab so repeated "Load data" clicks don't refetch.
- **Shopify token cache** — the OAuth access token is held in module-level state for 50 minutes across warm Vercel invocations.

## Reports available

- **KPIs:** revenue, orders, AOV, drafts sent, open drafts
- **Revenue by rep** (chart)
- **Monthly trend** (chart)
- **Rep summary** — revenue, order count, AOV
- **Draft sales by rep × sales type**
- **Order count by rep × source**
- **Vendor × rep**
- **Rep × draft status**
- **Channel performance**
- **Top 25 products by units sold** (Re:do vendor excluded — warranty/replacement program)

All revenue uses actual post-discount `line_revenue`. Tax and shipping are excluded — these are true sales subtotals.

## Cache management

Click the gear icon (⚙) in the header. You'll be prompted for `ADMIN_KEY` on first use (stored in sessionStorage until the tab closes).

The modal lists every cached month with size + cache timestamp. Clear any single month or clear all.

**When to clear:** if tags change retroactively on older orders (a rep tag was corrected), clear that month to force a fresh fetch on next load. Otherwise cached data is authoritative until you say otherwise.

## Security notes

- `DASHBOARD_PASSWORD` protects the data endpoints themselves — hitting `/api/orders` directly still requires auth.
- `ADMIN_KEY` is strictly required for the cache endpoint. No fallback.
- Both keys are held in `sessionStorage`, so closing the tab logs you out.
- Vercel env vars are never exposed to the browser.

## Performance

- Orders and drafts fetch in parallel per month.
- Shopify token cached across warm invocations for 50 min (with in-flight deduplication so cold-start races don't mint duplicate tokens).
- Adaptive throttling watches Shopify's `extensions.cost.throttleStatus` and backs off when the rate-limit bucket runs low.
- 8-second request timeout fails fast (before Vercel's 10-second Hobby plan timeout) with a clear error instead of a generic 504.
- Completed months served from Vercel Blob — instant, zero Shopify calls.
- Date-range filter uses `created_at:<next-month-start` (exclusive upper bound) so the last day of each month is fully included.

## External dependencies (with fallbacks)

The frontend pulls three CDN resources:

- **Chart.js** from cdnjs — required for charts (no graceful fallback; dashboard would break if blocked)
- **Google Fonts** (Bebas Neue + Inter) — falls back to system sans-serif if blocked
- **Shock Surplus logo** from Shopify CDN — falls back to a Bebas Neue text treatment if blocked

## Sharing

Send the Vercel URL + the dashboard password to your team. No login accounts, no Excel, works on any device.
