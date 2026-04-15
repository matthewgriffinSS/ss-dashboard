# Shock Surplus Dashboard - Deployment Guide

## Files
```
ss-dashboard/
├── api/
│   ├── orders.js          (Shopify orders API with auto-token)
│   └── draft-orders.js    (Shopify draft orders API with auto-token)
├── public/
│   └── index.html         (Interactive dashboard frontend)
├── package.json
└── vercel.json
```

## Deploy to Vercel (5 minutes)

### Step 1: Create a new project
1. Go to vercel.com and log in
2. Click "Add New" → "Project"
3. Choose "Import Third-Party Git Repository" or drag the folder

If using the Vercel CLI:
```
cd ss-dashboard
vercel
```

### Step 2: Add environment variables
In Vercel project settings → Environment Variables, add:

| Name | Value |
|------|-------|
| SHOPIFY_CLIENT_ID | Your client ID from the Shopify app |
| SHOPIFY_CLIENT_SECRET | Your client secret from the Shopify app |
| SHOPIFY_STORE | shock-surplus |

### Step 3: Deploy
Click "Deploy" or run `vercel --prod` from the CLI.

### Step 4: Access
Your dashboard is live at the URL Vercel gives you (something like `ss-dashboard.vercel.app`).

## What It Does
- Auto-renews the Shopify API token on every request (no manual token management)
- Pulls the last 60 days of orders and draft orders
- Extracts rep names from all tag prefixes (chat-, phone-, email-, richpanel-, etc.)
- Splits credit for multi-rep orders
- All 7 tables from your old Google Sheets dashboard
- Interactive filters for Rep, Month, Year, Sales Type
- Charts for revenue by rep and monthly trend
- KPIs with target tracking

## Updating KPI Targets
Edit public/index.html and find the `renderKPITable` function. Change the target values:
```javascript
{ name: 'Total Revenue', target: 1125000, ... },
{ name: 'Total Orders', target: 750, ... },
{ name: 'AOV', target: 800, ... },
{ name: 'Drafts Sent', target: 400, ... },
```

## Security
- Client ID and secret are stored as Vercel environment variables (never exposed to the browser)
- The API routes run server-side on Vercel
- The frontend only calls your own /api/ endpoints
- No Shopify credentials are ever sent to the browser

## Sharing
Share the Vercel URL with your team. Anyone with the link can view the dashboard. 
No login needed, no Excel required, works on any device.
