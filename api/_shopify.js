// Module-level cache persists across warm serverless invocations.
// Shopify client_credentials tokens are typically valid for ~1 hour;
// we cache for 50 min with a safety margin.
let cachedToken = null;
let cachedAt = 0;
const TTL_MS = 50 * 60 * 1000;

export async function getShopifyToken() {
  const { SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_STORE } = process.env;
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET || !SHOPIFY_STORE) {
    throw new Error('Missing Shopify env vars');
  }

  const now = Date.now();
  if (cachedToken && (now - cachedAt) < TTL_MS) {
    return cachedToken;
  }

  const res = await fetch(
    `https://${SHOPIFY_STORE}.myshopify.com/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${SHOPIFY_CLIENT_ID}&client_secret=${SHOPIFY_CLIENT_SECRET}`
    }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error('Token fetch failed');

  cachedToken = data.access_token;
  cachedAt = now;
  return cachedToken;
}

// Called by clear-cache endpoint so admins can force a token refresh
// without waiting for TTL (e.g., after rotating Shopify credentials).
export function invalidateToken() {
  cachedToken = null;
  cachedAt = 0;
}
