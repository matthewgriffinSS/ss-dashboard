import { put, list, head } from '@vercel/blob';

const PREFIXES = ['phone-','phones-','chat-','chats-','email-','richpanel-','richpannel-','slack-','wholesale-','rebuild-','save-','saved-','walkin-','walk-in-','social-','facebook-','instagram-','f&f-'];
const EXCLUDE_REPS = ['steve'];

function getToken() {
  const { SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_STORE } = process.env;
  return fetch(`https://${SHOPIFY_STORE}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${SHOPIFY_CLIENT_ID}&client_secret=${SHOPIFY_CLIENT_SECRET}`
  }).then(r => r.json()).then(d => d.access_token);
}

function getMonthsBetween(dateMin, dateMax) {
  const months = [];
  const start = new Date(dateMin + 'T00:00:00Z');
  const end = new Date(dateMax + 'T00:00:00Z');
  let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cursor <= end) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, '0');
    months.push({ key: `${y}-${m}`, year: y, month: cursor.getMonth() });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

function isCompleteMonth(key) {
  const now = new Date();
  const [y, m] = key.split('-').map(Number);
  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return key < currentKey;
}

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
          if (name && !reps.includes(name) && !EXCLUDE_REPS.includes(name.toLowerCase())) reps.push(name);
        }
      }
    }
    if (reps.length === 0) continue;
    const salesType = classifySalesType(tags, order.source_name);
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
          processed.push({
            ...base, vendor: item.vendor || '', item_title: item.title || '',
            item_price: parseFloat(item.price) || 0, item_qty: item.quantity || 0,
            line_revenue: (parseFloat(item.price) || 0) * (item.quantity || 0)
          });
        }
      }
    }
  }
  return processed;
}

async function fetchMonth(token, store, yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number);
  const dateMin = `${yearMonth}-01T00:00:00-00:00`;
  const lastDay = new Date(y, m, 0).getDate();
  const dateMax = `${yearMonth}-${String(lastDay).padStart(2, '0')}T23:59:59-00:00`;

  let all = [], sinceId = 0;
  while (true) {
    const url = `https://${store}.myshopify.com/admin/api/2024-10/orders.json?limit=250&status=any&since_id=${sinceId}&created_at_min=${dateMin}&created_at_max=${dateMax}`;
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (!res.ok) break;
    const data = await res.json();
    const orders = data.orders || [];
    all = all.concat(orders);
    if (orders.length < 250) break;
    sinceId = orders[orders.length - 1].id;
    await new Promise(r => setTimeout(r, 300));
  }
  return processOrders(all);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { SHOPIFY_STORE } = process.env;
  if (!SHOPIFY_STORE) return res.status(500).json({ error: 'Missing env vars' });

  try {
    const dateMin = req.query.date_min;
    const dateMax = req.query.date_max;
    if (!dateMin || !dateMax) return res.status(400).json({ error: 'date_min and date_max required' });

    const months = getMonthsBetween(dateMin, dateMax);
    const token = await getToken();
    if (!token) return res.status(401).json({ error: 'Token failed' });

    let allData = [];
    const cacheStatus = {};

    for (const month of months) {
      const blobKey = `orders-${month.key}.json`;
      const complete = isCompleteMonth(month.key);

      if (complete) {
        try {
          const blobHead = await head(blobKey);
          if (blobHead) {
            const cached = await fetch(blobHead.url).then(r => r.json());
            allData = allData.concat(cached);
            cacheStatus[month.key] = 'cached';
            continue;
          }
        } catch (e) {}
      }

      const data = await fetchMonth(token, SHOPIFY_STORE, month.key);
      allData = allData.concat(data);
      cacheStatus[month.key] = 'fetched';

      if (complete && data.length > 0) {
        try {
          await put(blobKey, JSON.stringify(data), { access: 'public', addRandomSuffix: false });
          cacheStatus[month.key] = 'cached_new';
        } catch (e) { console.error('Cache write failed:', e.message); }
      }
    }

    const startDate = new Date(dateMin + 'T00:00:00');
    const endDate = new Date(dateMax + 'T23:59:59');
    allData = allData.filter(o => {
      const d = new Date(o.created_at);
      return d >= startDate && d <= endDate;
    });

    res.status(200).json({ orders: allData, count: allData.length, cache: cacheStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
