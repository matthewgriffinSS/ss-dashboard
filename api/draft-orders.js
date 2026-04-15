import { put, list } from '@vercel/blob';

const PREFIXES = ['phone-','phones-','chat-','chats-','email-','richpanel-','richpannel-','slack-','wholesale-','rebuild-','save-','saved-','walkin-','walk-in-','social-','facebook-','instagram-','f&f-'];
const VALID_REPS = ['boggs','bowman','bryan','griffin','hector','joe','nick'];

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
  return 'Other';
}

function processDrafts(drafts) {
  const processed = [];
  for (const draft of drafts) {
    const tags = draft.tags || '';
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
    const salesType = classifySalesType(tags);
    const converted = draft.order_id != null && draft.order_id !== 0;
    for (const rep of reps) {
      const base = {
        id: draft.id, name: draft.name, status: draft.status,
        created_at: draft.created_at, updated_at: draft.updated_at,
        subtotal: parseFloat(draft.subtotal_price) || 0,
        invoice_sent_at: draft.invoice_sent_at, tags: draft.tags,
        converted, rep: rep.charAt(0).toUpperCase() + rep.slice(1),
        sales_type: salesType
      };
      const lineItems = draft.line_items || [];
      if (lineItems.length === 0) {
        processed.push({ ...base, vendor: '', item_title: '', item_price: 0, item_qty: 0, line_revenue: 0, line_discount: 0 });
      } else {
        for (const item of lineItems) {
          const discount = item.applied_discount ? parseFloat(item.applied_discount.amount || 0) : 0;
          processed.push({
            ...base, vendor: item.vendor || '', item_title: item.title || '',
            item_price: parseFloat(item.price) || 0, item_qty: item.quantity || 0,
            line_revenue: (parseFloat(item.price) || 0) * (item.quantity || 0),
            line_discount: discount
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

  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month param required (YYYY-MM)' });
  }

  const [y, m] = month.split('-').map(Number);
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const isComplete = month < currentMonth;
  const blobKey = `drafts-${month}.json`;

 if (isComplete) {
    try {
      const { blobs } = await list({ prefix: blobKey });
      if (blobs.length > 0) {
        const cached = await fetch(blobs[0].url).then(r => r.json());
        return res.status(200).json({ data: cached, source: 'cache', month });
      }
    } catch (e) { console.error('Cache read error:', e.message); }
  }

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
      const url = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2024-10/draft_orders.json?limit=250&since_id=${sinceId}&updated_at_min=${dateMin}&created_at_max=${dateMax}`;
      const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      if (!r.ok) { return res.status(r.status).json({ error: await r.text() }); }
      const d = await r.json();
      const drafts = d.draft_orders || [];
      allRaw = allRaw.concat(drafts);
      if (drafts.length < 250) break;
      sinceId = drafts[drafts.length - 1].id;
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    const processed = processDrafts(allRaw);

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
