# Shock Surplus Dashboard

## Files
```
ss-dashboard/
├── api/
│   ├── _shopify.js         (shared Shopify auth + token cache)
│   ├── _auth.js            (admin + dashboard auth helpers)
│   ├── orders.js           (orders + product enrichment, per-month, cached)
│   ├── draft-orders.js     (draft orders, per-month, cached)
│   ├── clear-cache.js      (admin: list/clear cached months + product catalog)
│   └── login.js            (dashboard password check)
├── public/
│   └── index.html          (frontend)
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
| `ADMIN_KEY`             | yes for cache UI | Separate key required to list or clear cached months         |
| `BLOB_READ_WRITE_TOKEN` | yes      | Vercel Blob token (auto-provisioned when you add Blob storage)       |

## Shopify scopes required

- `read_orders`
- `read_draft_orders`
- `read_products`

## How the data layer works

**Two-phase fetching for orders.** Each month, the orders endpoint runs two queries:

1. **Orders query** — pulls order records for the month via GraphQL with cursor pagination. 25 orders per page × 20 line items per page stays under Shopify's 1,000-point query-cost cap.
2. **Product catalog query** — collects all unique product IDs seen in the orders, looks them up in a shared catalog blob, and batch-fetches any missing products (80 per batch). The catalog holds product type, tags, and collection memberships — everything needed for vehicle-fit reports.

The product catalog is cached separately in `products-catalog.json` with a 24-hour TTL. Since products change rarely, this dramatically reduces API calls.

**Three cache tiers:**

- **Blob cache (persistent, per month)** — completed months are stored in Vercel Blob. Next load is instant.
- **Product catalog blob (24h TTL)** — shared across all months, refreshed daily.
- **Session cache (in-browser, per tab)** — the current month is cached in memory within a session so repeated loads don't refetch.

## Reports available

- **KPIs:** revenue, order count, AOV, drafts sent, open drafts
- **Rep summary** — revenue, order count, AOV per rep
- **Draft sales by rep × sales type**
- **Order count by rep × source**
- **Vendor × rep**
- **Rep × draft status**
- **Channel performance**
- **Product type × rep** — revenue matrix showing what each rep sells
- **Top 25 SKUs by revenue**
- **Top 10 vehicle fits** — collection-based fitment analytics (e.g. "2015-2020 Ford F150")
- **Vehicle attribute breakdown** — make / year / lift-amount splits by revenue and units

All revenue uses actual post-discount line revenue. Tax and shipping are excluded.

## Cache management

Click the gear icon (⚙) in the header. You'll be prompted for `ADMIN_KEY` on first use (stored in sessionStorage until the tab closes).

The modal lists every cached blob — monthly order/draft files plus `products-catalog.json`. Clear any of them individually or clear everything.

**When to clear:**
- **A month's cache** — if tags change retroactively on older orders (a rep tag was corrected), clear that month to force a refetch.
- **Product catalog** — if product types, tags, or collections change and you want those changes reflected immediately. Otherwise the catalog auto-refreshes every 24 hours.

## Security notes

- `DASHBOARD_PASSWORD` protects the data endpoints themselves — hitting `/api/orders` directly still requires auth.
- `ADMIN_KEY` is strictly required for the cache endpoint. No fallback.
- Both keys are held in `sessionStorage`, so closing the tab logs you out.
- Env vars are never exposed to the browser.

## Performance notes

- Orders and drafts fetch in parallel per month.
- Shopify access token is cached across warm invocations for 50 minutes.
- Adaptive throttling watches Shopify's `extensions.cost.throttleStatus` and backs off when the rate-limit bucket runs low.
- 8-second request timeout fails fast (before Vercel's 10-second Hobby plan timeout) with a clear error.
- Completed months are served from Vercel Blob — instant, no Shopify calls.

## Sharing

Send the Vercel URL + the dashboard password to your team. No login accounts, no Excel, works on any device.
