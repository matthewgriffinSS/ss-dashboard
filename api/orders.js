import { put, head } from '@vercel/blob';
import { getShopifyToken } from './_shopify.js';
import { requireDashAuth } from './_auth.js';

const PREFIXES = ['phone-','phones-','chat-','chats-','email-','richpanel-','richpannel-','slack-','wholesale-','rebuild-','save-','saved-','walkin-','walk-in-','social-','facebook-','instagram-','f&f-'];
const VALID_REPS = ['boggs','bowman','bryan','griffin','hector','joe','nick'];

// Product catalog blob key + TTL. Products change rarely enough that a daily
// refresh is fine; the catalog is shared across all months and orders.
const PRODUCT_CATALOG_KEY = 'products-catalog.json';
const PRODUCT_CATALOG_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function classifySalesType(tags, source) {
  const t = (tags || '').toLowerCase();
  if (t.includes('phone')) return 'Phone';
  if (t.includes('chat')) return 'Chat';
  if (t.includes('email')) return 'Email';
  if (t.includes('rich') || t.includes('slack')) return 'Richpanel';
  if (t.includes('wholesale')) return 'Wholesale';
  if (t.includes('rebuild')) return 'Rebuild';
  if (t.includes('save')) return 'Saved';
  if (t.includes('walk')) return 'Walk In';
  if (t.includes('social') || t.includes('facebook') || t.includes('instagram')) return 'Social';
  if (t.includes('f&f')) return 'F&F';
  if (source === 'shopify_draft_order') return 'Draft Order';
  if (source === 'web') return 'Web';
  return 'Other';
}

function tagsToString(tags) {
  if (!tags) return '';
  if (Array.isArray(tags)) return tags.join(', ');
  return String(tags);
}

function idFromGid(gid) {
  if (!gid) return null;
  const m = String(gid).match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

// ============================================================
// Phase 1: Orders query (lean - no product details inline)
// Cost budget: 25 orders/page × (1 order + 20 line items × 1) ≈ 525 pts — safe.
// ============================================================

const ORDERS_QUERY = `
  query OrdersByRange($query: String!, $cursor: String) {
    orders(first: 25, after: $cursor, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          createdAt
          tags
          sourceName
          displayFinancialStatus
          currentSubtotalPriceSet { shopMoney { amount } }
          lineItems(first: 20) {
            edges {
              node {
                title
                vendor
                quantity
                sku
                originalUnitPriceSet { shopMoney { amount } }
                discountedTotalSet { shopMoney { amount } }
                product { id }
                variant { id title }
              }
            }
          }
        }
      }
    }
  }
`;

function normalizeGqlOrder(node) {
  const lineItems = (node.lineItems?.edges || []).map(e => {
    const li = e.node;
    const price = parseFloat(li.originalUnitPriceSet?.shopMoney?.amount || 0);
    const qty = li.quantity || 0;
    const gross = price * qty;
    const discounted = parseFloat(li.discountedTotalSet?.shopMoney?.amount || gross);
    return {
      title: li.title || '',
      vendor: li.vendor || '',
      sku: li.sku || '',
      price,
      quantity: qty,
      line_revenue: discounted, // post-line-discount actual revenue
      line_discount: Math.max(0, gross - discounted),
      product_id: li.product?.id ? idFromGid(li.product.id) : null,
      variant_id: li.variant?.id ? idFromGid(li.variant.id) : null,
      variant_title: li.variant?.title || ''
    };
  });

  return {
    id: idFromGid(node.id),
    name: node.name || '',
    created_at: node.createdAt,
    current_subtotal_price: node.currentSubtotalPriceSet?.shopMoney?.amount || '0',
    financial_status: (node.displayFinancialStatus || '').toLowerCase(),
    source_name: node.sourceName || '',
    tags: tagsToString(node.tags),
    line_items: lineItems
  };
}

function nextMonthStart(year, month /* 1-12 */) {
  if (month === 12) return `${year + 1}-01-01`;
  return `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

async function fetchOrdersGraphQL(token, store, month, year, monthNum) {
  const dateMin = `${month}-01`;
  const dateMaxExclusive = nextMonthStart(year, monthNum);
  const queryStr = `created_at:>=${dateMin} created_at:<${dateMaxExclusive}`;

  const url = `https://${store}.myshopify.com/admin/api/2024-10/graphql.json`;
  const all = [];
  let cursor = null;
  let lastCost = null;

  while (true) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: ORDERS_QUERY, variables: { query: queryStr, cursor } }),
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('Shopify orders request timed out');
      throw e;
    }
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Orders GraphQL ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = await res.json();
    if (json.errors) {
      throw new Error('Orders GraphQL errors: ' + JSON.stringify(json.errors).slice(0, 500));
    }
    if (json.extensions?.cost?.throttleStatus) lastCost = json.extensions.cost;

    const connection = json.data?.orders;
    if (!connection) break;
    for (const edge of connection.edges) all.push(normalizeGqlOrder(edge.node));

    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;

    let delay = 150;
    if (lastCost?.throttleStatus?.currentlyAvailable != null) {
      const avail = lastCost.throttleStatus.currentlyAvailable;
      if (avail < 200) delay = 1000;
      else if (avail < 500) delay = 400;
    }
    await new Promise(r => setTimeout(r, delay));
  }

  return { orders: all, lastCost };
}

// ============================================================
// Phase 2: Product catalog fetcher (batched nodes query)
// Cost budget: 80 products/batch × (1 product + 10 collections + 1 tags) = 960 pts.
// Catalog cached for 24h in a separate blob — products change rarely.
// ============================================================

const PRODUCTS_QUERY = `
  query ProductsById($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        productType
        tags
        collections(first: 10) {
          edges { node { title } }
        }
      }
    }
  }
`;

async function fetchProductDetails(token, store, productIdsInt) {
  const url = `https://${store}.myshopify.com/admin/api/2024-10/graphql.json`;
  const catalog = {};
  const CHUNK = 80;

  for (let i = 0; i < productIdsInt.length; i += CHUNK) {
    const chunk = productIdsInt.slice(i, i + CHUNK).map(id => `gid://shopify/Product/${id}`);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: PRODUCTS_QUERY, variables: { ids: chunk } }),
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('Shopify products request timed out');
      throw e;
    }
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Products GraphQL ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = await res.json();
    if (json.errors) {
      throw new Error('Products GraphQL errors: ' + JSON.stringify(json.errors).slice(0, 500));
    }

    for (const node of (json.data?.nodes || [])) {
      if (!node || !node.id) continue;
      const intId = idFromGid(node.id);
      catalog[intId] = {
        product_type: node.productType || '',
        tags: Array.isArray(node.tags) ? node.tags : [],
        collections: (node.collections?.edges || []).map(e => e.node.title).filter(Boolean)
      };
    }

    // Light throttle between batches
    await new Promise(r => setTimeout(r, 200));
  }

  return catalog;
}

// Load catalog from blob if fresh, otherwise return null so caller can build one.
async function loadCachedCatalog() {
  try {
    const blob = await head(PRODUCT_CATALOG_KEY);
    if (!blob?.url || !blob.uploadedAt) return null;
    const age = Date.now() - new Date(blob.uploadedAt).getTime();
    if (age > PRODUCT_CATALOG_TTL_MS) return null;
    const data = await fetch(blob.url).then(r => r.json());
    return data;
  } catch (e) {
    return null;
  }
}

async function saveCachedCatalog(catalog) {
  try {
    await put(PRODUCT_CATALOG_KEY, JSON.stringify(catalog), {
      access: 'public',
      addRandomSuffix: false
    });
  } catch (e) {
    console.error('Catalog cache write failed:', e.message);
  }
}

// ============================================================
// processOrders: flatten + enrich with catalog data
// ============================================================

function processOrders(orders, catalog) {
  const processed = [];
  for (const order of orders) {
    const tags = order.tags || '';
    const tagList = tags.split(', ').map(t => t.trim().toLowerCase());
    const reps = [];
    for (const tag of tagList) {
      for (const prefix of PREFIXES) {
        if (tag.startsWith(prefix)) {
          const name = tag.slice(prefix.length);
          if (name && !reps.includes(name) && VALID_REPS.includes(name.toLowerCase())) reps.push(name);
        }
      }
    }
    if (reps.length === 0) continue;
    const salesType = classifySalesType(tags, order.source_name);
    for (const rep of reps) {
      const base = {
        id: order.id, name: order.name, created_at: order.created_at,
        subtotal: parseFloat(order.current_subtotal_price) || 0,
        financial_status: order.financial_status,
        source: order.source_name, tags: order.tags,
        rep: rep.charAt(0).toUpperCase() + rep.slice(1),
        sales_type: salesType
      };
      const lineItems = order.line_items || [];
      if (lineItems.length === 0) {
        processed.push({
          ...base,
          vendor: '', item_title: '', sku: '',
          item_price: 0, item_qty: 0, line_revenue: 0,
          product_type: '', product_tags: [], product_collections: []
        });
      } else {
        for (const item of lineItems) {
          const cat = (item.product_id && catalog[item.product_id]) || {};
          processed.push({
            ...base,
            vendor: item.vendor || '',
            item_title: item.title || '',
            sku: item.sku || '',
            item_price: item.price,
            item_qty: item.quantity,
            line_revenue: item.line_revenue, // post-discount actual line revenue
            variant_title: item.variant_title || '',
            product_type: cat.product_type || '',
            product_tags: cat.tags || [],
            product_collections: cat.collections || []
          });
        }
      }
    }
  }
  return processed;
}

// ============================================================
// Main handler
// ============================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-dash-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!requireDashAuth(req, res)) return;

  const { SHOPIFY_STORE } = process.env;
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month param required (YYYY-MM)' });
  }

  const [y, m] = month.split('-').map(Number);
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const isComplete = month < currentMonth;
  const blobKey = `orders-${month}.json`;

  if (isComplete) {
    try {
      const blob = await head(blobKey);
      if (blob && blob.url) {
        const cached = await fetch(blob.url).then(r => r.json());
        return res.status(200).json({ data: cached, source: 'cache', month });
      }
    } catch (e) { /* not cached */ }
  }

  try {
    const token = await getShopifyToken();

    // Phase 1: get orders
    const { orders: rawOrders, lastCost } = await fetchOrdersGraphQL(token, SHOPIFY_STORE, month, y, m);

    // Phase 2: collect unique product IDs, load catalog (cached), fetch missing.
    const uniqProductIds = new Set();
    for (const o of rawOrders) for (const li of (o.line_items || [])) {
      if (li.product_id) uniqProductIds.add(li.product_id);
    }

    let catalog = (await loadCachedCatalog()) || {};
    const missing = [...uniqProductIds].filter(id => !catalog[id]);
    if (missing.length > 0) {
      const fresh = await fetchProductDetails(token, SHOPIFY_STORE, missing);
      catalog = { ...catalog, ...fresh };
      // Fire-and-forget cache write — don't block response on it.
      saveCachedCatalog(catalog);
    }

    const processed = processOrders(rawOrders, catalog);

    if (isComplete && processed.length > 0) {
      try {
        await put(blobKey, JSON.stringify(processed), { access: 'public', addRandomSuffix: false });
      } catch (e) { console.error('Cache write error:', e.message); }
    }

    res.status(200).json({
      data: processed,
      source: 'live',
      month,
      rawCount: rawOrders.length,
      productsHydrated: Object.keys(catalog).length,
      productsMissing: missing.length,
      costInfo: lastCost
    });
  } catch (err) {
    res.status(500).json({ error: err.message, month });
  }
}
