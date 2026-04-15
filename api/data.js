import { kv } from '@vercel/kv';

const PREFIXES = ['phone-','phones-','chat-','chats-','email-','richpanel-','richpannel-','slack-','wholesale-','rebuild-','save-','saved-','walkin-','walk-in-','social-','facebook-','instagram-','f&f-'];
const EXCLUDE_REPS = ['steve'];

function classifySalesType(tags) {
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
  return null;
}

function extractReps(tags) {
  const tagList = (tags || '').split(', ').map(t => t.trim().toLowerCase());
  const reps = [];
  for (const tag of tagList) {
    for (const prefix of PREFIXES) {
      if (tag.startsWith(prefix)) {
        const name = tag.slice(prefix.length);
        if (name && !reps.includes(name) && !EXCLUDE_REPS.includes(name.toLowerCase())) {
          reps.push(name);
        }
      }
    }
  }
  return reps;
}

function processOrders(orders) {
  const processed = [];
  for (const order of orders) {
    const reps = extractReps(order.tags);
    if (reps.length === 0) continue;

    const salesType = classifySalesType(order.tags) ||
      (order.source_name === 'shopify_draft_order' ? 'Draft Order' :
       order.source_name === 'web' ? 'Web' : 'Other');

    for (const rep of reps) {
      const lineItems = order.line_items || [];
      const base = {
        id: order.id, name: order.name, created_at: order.created_at,
        total_price: parseFloat(order.total_price) || 0,
        subtotal: parseFloat(order.current_subtotal_price) || 0,
        discounts: parseFloat(order.total_discounts) || 0,
        tax: parseFloat(order.total_tax) || 0,
        financial_status: order.financial_status,
        fulfillment_status: order.fulfillment_status,
        source: order.source_name, tags: order.tags, email: order.email,
        customer: order.customer ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() : '',
        rep: rep.charAt(0).toUpperCase() + rep.slice(1),
        sales_type: salesType
      };
      if (lineItems.length === 0) {
        processed.push({ ...base, vendor: '', item_title: '', item_price: 0, item_qty: 0, line_revenue: 0 });
      } else {
        for (const item of lineItems) {
          processed.push({ ...base, vendor: item.vendor || '', item_title: item.title || '',
            item_price: parseFloat(item.price) || 0, item_qty: item.quantity || 0,
            line_revenue: (parseFloat(item.price) || 0) * (item.quantity || 0) });
        }
      }
    }
  }
  return processed;
}

function processDrafts(drafts) {
  const processed = [];
  for (const draft of drafts) {
    const reps = extractReps(draft.tags);
    if (reps.length === 0) continue;

    const salesType = classifySalesType(draft.tags) || 'Other';
    const converted = draft.order_id != null && draft.order_id !== 0;

    for (const rep of reps) {
      const lineItems = draft.line_items || [];
      const base = {
        id: draft.id, name: draft.name, status: draft.status,
        created_at: draft.created_at, updated_at: draft.updated_at,
        subtotal: parseFloat(draft.subtotal_price) || 0,
        invoice_sent_at: draft.invoice_sent_at, tags: draft.tags,
        converted, rep: rep.charAt(0).toUpperCase() + rep.slice(1),
        sales_type: salesType
      };
      if (lineItems.length === 0) {
        processed.push({ ...base, vendor: '', item_title: '', item_price: 0, item_qty: 0, line_revenue: 0, line_discount: 0 });
      } else {
        for (const item of lineItems) {
          const discount = item.applied_discount ? parseFloat(item.applied_discount.amount || 0) : 0;
          processed.push({ ...base, vendor: item.vendor || '', item_title: item.title || '',
            item_price: parseFloat(item.price) || 0, item_qty: item.quantity || 0,
            line_revenue: (parseFloat(item.price) || 0) * (item.quantity || 0), line_discount: discount });
        }
      }
    }
  }
  return processed;
}

async function getToken() {
  const { SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_STORE } = process.env;
  const res = await fetch(`https://${SHOPIFY_STORE}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${SHOPIFY_CLIENT_ID}&client_secret=${SHOPIFY_CLIENT_SECRET}`
  });
  const data = await res.json();
  return data.access_token;
}

async function fetchShopifyPages(token, endpoint, dateMin, dateMax) {
  const store = process.env.SHOPIFY_STORE;
  let all = [], sinceId = 0;
  while (true) {
    let url = `https://${store}.myshopify.com/admin/api/2024-10/${endpoint}.json?limit=250&since_id=${sinceId}`;
    if (endpoint === 'orders') url += '&status=any';
    url += `&created_at_min=${dateMin}T00:00:00-00:00&created_at_max=${dateMax}T23:59:59-00:00`;

    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (!res.ok) break;
    const data = await res.json();
    const items = data[endpoint] || data.draft_orders || [];
    all = all.concat(items);
    if (items.length < 250) break;
    sinceId = items[items.length - 1].id;
    await new Promise(r => setTimeout(r, 300));
  }
  return all;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, year, month } = req.query;
  if (!type || !year || !month) {
    return res.status(400).json({ error: 'Required: type (orders/drafts), year, month (1-12)' });
  }

  const y = parseInt(year);
  const m = parseInt(month);
  const cacheKey = `${type}:${y}:${String(m).padStart(2, '0')}`;

  // Determine if this month is "complete" (not the current month)
  const now = new Date();
  const isCurrentMonth = y === now.getFullYear() && m === (now.getMonth() + 1);
  const isFutureMonth = new Date(y, m - 1, 1) > now;

  if (isFutureMonth) {
    return res.status(200).json({ data: [], cached: false, month: cacheKey });
  }

  // Check cache for completed months
  if (!isCurrentMonth) {
    try {
      const cached = await kv.get(cacheKey);
      if (cached) {
        return res.status(200).json({ data: cached, cached: true, month: cacheKey });
      }
    } catch (e) { /* cache miss, fetch fresh */ }
  }

  // Fetch from Shopify
  try {
    const token = await getToken();
    if (!token) return res.status(401).json({ error: 'Token failed' });

    const lastDay = new Date(y, m, 0).getDate();
    const dateMin = `${y}-${String(m).padStart(2, '0')}-01`;
    const dateMax = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const endpoint = type === 'drafts' ? 'draft_orders' : 'orders';
    const raw = await fetchShopifyPages(token, endpoint, dateMin, dateMax);
    const processed = type === 'drafts' ? processDrafts(raw) : processOrders(raw);

    // Cache completed months (not current month)
    if (!isCurrentMonth && processed.length > 0) {
      try {
        await kv.set(cacheKey, processed);
      } catch (e) { console.error('Cache write failed:', e.message); }
    }

    return res.status(200).json({ data: processed, cached: false, month: cacheKey, rawCount: raw.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
