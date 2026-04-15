export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_STORE } = process.env;
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET || !SHOPIFY_STORE) {
    return res.status(500).json({ error: 'Missing environment variables' });
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

    const sinceId = req.query.since_id || '0';
    const daysBack = req.query.days || '60';
    const minDate = new Date(Date.now() - parseInt(daysBack) * 86400000).toISOString().split('T')[0];

    const url = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2024-10/draft_orders.json?limit=250&since_id=${sinceId}&updated_at_min=${minDate}`;

    const draftRes = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': token }
    });

    if (!draftRes.ok) {
      const err = await draftRes.text();
      return res.status(draftRes.status).json({ error: err });
    }

    const data = await draftRes.json();
    const drafts = data.draft_orders || [];

    const prefixes = ['phone-','phones-','chat-','chats-','email-','richpanel-','richpannel-','slack-','wholesale-','rebuild-','save-','saved-','walkin-','walk-in-','social-','facebook-','instagram-','f&f-'];

    const processed = [];
    for (const draft of drafts) {
      const tags = draft.tags || '';
      const tagList = tags.split(', ').map(t => t.trim().toLowerCase());

      const reps = [];
      for (const tag of tagList) {
        for (const prefix of prefixes) {
          if (tag.startsWith(prefix)) {
            const name = tag.slice(prefix.length);
            if (name && !reps.includes(name)) reps.push(name);
          }
        }
      }

      let salesType = 'Other';
      const lowerTags = tags.toLowerCase();
      if (lowerTags.includes('phone')) salesType = 'Phone';
      else if (lowerTags.includes('chat')) salesType = 'Chat';
      else if (lowerTags.includes('email')) salesType = 'Email';
      else if (lowerTags.includes('rich') || lowerTags.includes('slack')) salesType = 'Richpanel';
      else if (lowerTags.includes('wholesale')) salesType = 'Wholesale';
      else if (lowerTags.includes('rebuild')) salesType = 'Rebuild';
      else if (lowerTags.includes('save')) salesType = 'Saved';
      else if (lowerTags.includes('walk')) salesType = 'Walk In';
      else if (lowerTags.includes('social') || lowerTags.includes('facebook') || lowerTags.includes('instagram')) salesType = 'Social';
      else if (lowerTags.includes('f&f')) salesType = 'F&F';

      const repList = reps.length > 0 ? reps : ['Unassigned'];
      const converted = draft.order_id != null && draft.order_id !== 0;

      for (const rep of repList) {
        const lineItems = draft.line_items || [];
        if (lineItems.length === 0) {
          processed.push({
            id: draft.id,
            name: draft.name,
            status: draft.status,
            created_at: draft.created_at,
            updated_at: draft.updated_at,
            subtotal: parseFloat(draft.subtotal_price) || 0,
            invoice_sent_at: draft.invoice_sent_at,
            tags: draft.tags,
            converted,
            rep: rep.charAt(0).toUpperCase() + rep.slice(1),
            sales_type: salesType,
            vendor: '',
            item_title: '',
            item_price: 0,
            item_qty: 0,
            line_revenue: 0,
            line_discount: 0
          });
        } else {
          for (const item of lineItems) {
            const discount = item.applied_discount ? parseFloat(item.applied_discount.amount || 0) : 0;
            processed.push({
              id: draft.id,
              name: draft.name,
              status: draft.status,
              created_at: draft.created_at,
              updated_at: draft.updated_at,
              subtotal: parseFloat(draft.subtotal_price) || 0,
              invoice_sent_at: draft.invoice_sent_at,
              tags: draft.tags,
              converted,
              rep: rep.charAt(0).toUpperCase() + rep.slice(1),
              sales_type: salesType,
              vendor: item.vendor || '',
              item_title: item.title || '',
              item_price: parseFloat(item.price) || 0,
              item_qty: item.quantity || 0,
              line_revenue: (parseFloat(item.price) || 0) * (item.quantity || 0),
              line_discount: discount
            });
          }
        }
      }
    }

    const lastId = drafts.length > 0 ? drafts[drafts.length - 1].id : null;
    const hasMore = drafts.length === 250;

    res.status(200).json({
      drafts: processed,
      lastId,
      hasMore,
      rawCount: drafts.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
