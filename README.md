Shock Surplus Dashboard
Files
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
│   └── index.html          (frontend)
├── package.json
└── vercel.json
```
Deploy to Vercel
Import the project in Vercel (or run `vercel` in the folder).
Add environment variables (see below).
Deploy (`vercel --prod`).
Visit the URL Vercel gives you.
Environment variables
Name	Required	Purpose
`SHOPIFY_CLIENT_ID`	yes	Shopify app client ID
`SHOPIFY_CLIENT_SECRET`	yes	Shopify app client secret
`SHOPIFY_STORE`	yes	Store handle, e.g. `shock-surplus`
`DASHBOARD_PASSWORD`	optional	If set, users must enter this password to view the dashboard
`ADMIN_KEY`	required for cache UI	Separate key required to list or clear cached months
`BLOB_READ_WRITE_TOKEN`	yes	Vercel Blob token (auto-provisioned when you add Blob storage)
Tip: Generate strong values with `openssl rand -hex 24` or any password generator. Keep `ADMIN_KEY` different from `DASHBOARD_PASSWORD` — the cache UI gives destructive power.
If `DASHBOARD_PASSWORD` is unset, the dashboard is open to anyone with the URL (backwards compatible with the original setup).
What it does
Monthly Shopify pulls, one request per calendar month
Completed months auto-cache to Vercel Blob; next load is instant
Shopify access token is minted once per ~50 min instead of every request
Current-month data is cached in-browser per session (page refresh clears it)
Extracts rep names from tag prefixes (`chat-`, `phone-`, `email-`, `richpanel-`, etc.)
Splits credit for multi-rep orders
Interactive filters for rep, month
Charts for revenue by rep and monthly trend
KPI row for revenue, order count, AOV, drafts sent, open drafts
Cache management
Click the gear icon (⚙) in the header. You'll be prompted for `ADMIN_KEY` on first use (stored in sessionStorage until the tab closes).
The modal shows every cached month with its size and cache timestamp. Clear one month or clear all. Next time anyone loads a range that includes a cleared month, it'll refetch from Shopify and re-cache.
When to clear cache: if tags change retroactively on older orders (e.g., a rep tag gets corrected), the cached version of that month will be stale until you clear it.
Security notes
The dashboard password protects the data endpoints, not just the UI. Someone can't bypass it by hitting `/api/orders` directly.
`ADMIN_KEY` is strictly required for the cache endpoint — there's no fallback.
Both keys are held in `sessionStorage` (not `localStorage`), so closing the browser tab logs you out.
Vercel env vars are never exposed to the browser.
Updating KPI targets
Edit `public/index.html`, find `renderKPITable`, change target values. (If you haven't added target tracking yet, the KPI row currently just shows live numbers.)
Sharing
Send the Vercel URL + the dashboard password to your team. No login accounts, no Excel, works on any device.
