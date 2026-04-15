import { put, head } from '@vercel/blob';

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
            item_price: parseFloat(item.price) || 0, item_qty: item.quantity || 0,
            line_revenue: (parseFloat(item.price) || 0) * (item.quantity || 0)
          });
        }
      }
    }
  }
  return processed;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_STORE } = process.env;
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET || !SHOPIFY_STORE) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  const month = req.query.month; // format: 2026-01
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month param required (YYYY-MM)' });
  }

  const [y, m] = month.split('-').map(Number);
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const isComplete = month < currentMonth;
  const blobKey = `orders-${month}.json`;

  // Check cache for completed months
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

  // Fetch from Shopify
  try {
    const tokenRes = await fetch(`https://${SHOPIFY_STORE}.myshopify.com/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${SHOPIFY_CLIENT_ID}&client_secret=${SHOPIFY_CLIENT_SECRET}`
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.status(401).json({ error: 'Token failed' });
    const token = tokenData.access_token;

    const lastDay = new Date(y, m, 0).getDate();
    const dateMin = `${month}-01T00:00:00-00:00`;
    const dateMax = `${month}-${String(lastDay).padStart(2, '0')}T23:59:59-00:00`;

    let allRaw = [], sinceId = 0;
    while (true) {
      const url = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2024-10/orders.json?limit=250&status=any&since_id=${sinceId}&created_at_min=${dateMin}&created_at_max=${dateMax}`;
      const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      if (!r.ok) { return res.status(r.status).json({ error: await r.text() }); }
      const d = await r.json();
      const orders = d.orders || [];
      allRaw = allRaw.concat(orders);
      if (orders.length < 250) break;
      sinceId = orders[orders.length - 1].id;
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    const processed = processOrders(allRaw);

    // Cache completed months
    if (isComplete && processed.length > 0) {
      try {
        await put(blobKey, JSON.stringify(processed), { access: 'public', addRandomSuffix: false });
      } catch (e) { console.error('Cache write error:', e.message); }
    }

    res.status(200).json({ data: processed, source: 'live', month, rawCount: allRaw.length });
  } catch (err) {
    res.status(500).json({ error: err.message, month });
  }
}
