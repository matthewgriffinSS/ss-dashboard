import { put, head } from '@vercel/blob';
import { getShopifyToken } from './_shopify.js';
import { requireDashAuth } from './_auth.js';

// Allow up to 60s of execution time. Heavy months can require multiple
// paginated GraphQL calls and will exceed the default 10s.
export const maxDuration = 60;

const VALID_REPS = ['boggs','bowman','bryan','griffin','hector','jeff','joe','nick'];

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

const ORDERS_QUERY = `
  query OrdersByRange($query: String!, $cursor: String) {
    orders(first: 40, after: $cursor, query: $query, sortKey: CREATED_AT) {
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
              }
            }
          }
        }
      }
    }
  }
`;

function normalizeGqlOrder(node) {
  const orderSubtotal = parseFloat(
    node.currentSubtotalPriceSet?.shopMoney?.amount || 0
  );

  const lineItems = (node.lineItems?.edges || []).map(e => {
    const li = e.node;
    const price = parseFloat(li.originalUnitPriceSet?.shopMoney?.amount || 0);
    const qty = li.quantity || 0;
    const discounted = parseFloat(li.discountedTotalSet?.shopMoney?.amount || price * qty);
    return {
      title: li.title || '',
      vendor: li.vendor || '',
      sku: li.sku || '',
      price,
      quantity: qty,
      discounted,
      line_revenue: discounted
    };
  });

  // Proportionally distribute currentSubtotalPriceSet (post-refund, post-discount)
  // across line items based on each line's share of the discounted total
  const totalDiscounted = lineItems.reduce((sum, li) => sum + li.discounted, 0);
  if (totalDiscounted > 0) {
    for (const li of lineItems) {
      li.line_revenue = (li.discounted / totalDiscounted) * orderSubtotal;
    }
  }

  for (const li of lineItems) delete li.discounted;

  return {
    id: idFromGid(node.id),
    name: node.name || '',
    created_at: node.createdAt,
    current_subtotal_price: String(orderSubtotal),
    financial_status: (node.displayFinancialStatus || '').toLowerCase(),
    source_name: node.sourceName || '',
    tags: tagsToString(node.tags),
    line_items: lineItems
  };
}

function nextMonthStart(year, month) {
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
    // Per-request timeout. Generous enough for slow Shopify pages but well
    // under maxDuration so we still fail fast on a true network hang.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
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

function processOrders(orders) {
  const processed = [];
  for (const order of orders) {
    const tags = order.tags || '';
    const tagList = tags.split(', ').map(t => t.trim().toLowerCase());
    const reps = [];
    for (const tag of tagList) {
      for (const rep of VALID_REPS) {
        if ((tag === rep || tag.endsWith('-' + rep)) && !reps.includes(rep)) {
          reps.push(rep);
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
        processed.push({ ...base, vendor: '', item_title: '', sku: '', item_price: 0, item_qty: 0, line_revenue: 0 });
      } else {
        for (const item of lineItems) {
          processed.push({
            ...base,
            vendor: item.vendor || '',
            item_title: item.title || '',
            sku: item.sku || '',
            item_price: item.price,
            item_qty: item.quantity,
            line_revenue: item.line_revenue
          });
        }
      }
    }
  }
  return processed;
}

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
  // Cache only months that are at least 2 months old. Current and previous
  // month always fetch live so retroactive tag fixes show up without
  // requiring a manual cache clear.
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const cutoffMonth = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}`;
  const isComplete = month < cutoffMonth;
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
    const { orders: rawOrders, lastCost } = await fetchOrdersGraphQL(token, SHOPIFY_STORE, month, y, m);
    const processed = processOrders(rawOrders);

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
      costInfo: lastCost
    });
  } catch (err) {
    res.status(500).json({ error: err.message, month });
  }
}
