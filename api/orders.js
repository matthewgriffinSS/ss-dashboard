import { put, head } from '@vercel/blob';
import { getShopifyToken } from './_shopify.js';
import { requireDashAuth } from './_auth.js';

const PREFIXES = ['phone-','phones-','chat-','chats-','email-','richpanel-','richpannel-','slack-','wholesale-','rebuild-','save-','saved-','walkin-','walk-in-','social-','facebook-','instagram-','f&f-'];
const VALID_REPS = ['boggs','bowman','bryan','griffin','hector','joe','nick'];

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

function normalizeGqlOrder(node) {
  const lineItems = (node.lineItems?.edges || []).map(e => {
    const li = e.node;
    return {
      title: li.title || '',
      vendor: li.vendor || '',
      price: parseFloat(li.originalUnitPriceSet?.shopMoney?.amount || 0),
      quantity: li.quantity || 0
    };
  });

  return {
    id: idFromGid(node.id),
    name: node.name || '',
    created_at: node.createdAt,
    current_subtotal_price: node.currentSubtotalPriceSet?.shopMoney?.amount || '0',
    total_discounts: node.totalDiscountsSet?.shopMoney?.amount || '0',
    financial_status: (node.displayFinancialStatus || '').toLowerCase(),
    source_name: node.sourceName || '',
    tags: tagsToString(node.tags),
    line_items: lineItems
  };
}

function processOrders(orders) {
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
        discounts: parseFloat(order.total_discounts) || 0,
        financial_status: order.financial_status,
        source: order.source_name, tags: order.tags,
        rep: rep.charAt(0).toUpperCase() + rep.slice(1),
        sales_type: salesType
      };
      const lineItems = order.line_items || [];
      if (lineItems.length === 0) {
        processed.push({ ...base, vendor: '', item_title: '', item_price: 0, item_qty: 0, line_revenue: 0 });
      } else {
        for (const item of lineItems) {
          processed.push({
            ...base, vendor: item.vendor || '', item_title: item.title || '',
            item_price: item.price, item_qty: item.quantity,
            line_revenue: item.price * item.quantity
          });
        }
      }
    }
  }
  return processed;
}

const GQL_QUERY = `
  query OrdersByRange($query: String!, $cursor: String) {
    orders(first: 100, after: $cursor, query: $query, sortKey: CREATED_AT) {
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
          totalDiscountsSet { shopMoney { amount } }
          lineItems(first: 100) {
            edges {
              node {
                title
                vendor
                quantity
                originalUnitPriceSet { shopMoney { amount } }
              }
            }
          }
        }
      }
    }
  }
`;

async function fetchOrdersGraphQL(token, store, month, lastDay) {
  const dateMin = `${month}-01`;
  const dateMax = `${month}-${String(lastDay).padStart(2, '0')}`;
  const queryStr = `created_at:>=${dateMin} created_at:<=${dateMax}`;

  const url = `https://${store}.myshopify.com/admin/api/2024-10/graphql.json`;
  const all = [];
  let cursor = null;

  while (true) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: GQL_QUERY, variables: { query: queryStr, cursor } })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GraphQL ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = await res.json();
    if (json.errors) {
      throw new Error('GraphQL errors: ' + JSON.stringify(json.errors).slice(0, 500));
    }

    const connection = json.data?.orders;
    if (!connection) break;

    for (const edge of connection.edges) {
      all.push(normalizeGqlOrder(edge.node));
    }

    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
    await new Promise(r => setTimeout(r, 150));
  }

  return all;
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
    } catch (e) {
      // Not cached, fetch from Shopify
    }
  }

  try {
    const token = await getShopifyToken();
    const lastDay = new Date(y, m, 0).getDate();
    const rawOrders = await fetchOrdersGraphQL(token, SHOPIFY_STORE, month, lastDay);
    const processed = processOrders(rawOrders);

    if (isComplete && processed.length > 0) {
      try {
        await put(blobKey, JSON.stringify(processed), { access: 'public', addRandomSuffix: false });
      } catch (e) { console.error('Cache write error:', e.message); }
    }

    res.status(200).json({ data: processed, source: 'live', month, rawCount: rawOrders.length });
  } catch (err) {
    res.status(500).json({ error: err.message, month });
  }
}
