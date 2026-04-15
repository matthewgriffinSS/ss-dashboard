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
    if (!tokenData.access_token) return res.status(401).json({ error: 'Token failed', detail: tokenData });
    const token = tokenData.access_token;

    const sinceId = req.query.since_id || '0';
    const dateMin = req.query.date_min || '';
    const dateMax = req.query.date_max || '';

    let url = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2024-10/orders.json?limit=250&status=any&since_id=${sinceId}`;
    if (dateMin) url += `&created_at_min=${dateMin}T00:00:00-00:00`;
    if (dateMax) url += `&created_at_max=${dateMax}T23:59:59-00:00`;

    const orderRes = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': token }
    });

    if (!orderRes.ok) {
      const err = await orderRes.text();
      return res.status(orderRes.status).json({ error: err });
    }

    const data = await orderRes.json();
    const orders = data.orders || [];

    const prefixes = ['phone-','phones-','chat-','chats-','email-','richpanel-','richpannel-','slack-','wholesale-','rebuild-','save-','saved-','walkin-','walk-in-','social-','facebook-','instagram-','f&f-'];
    const excludeReps = ['steve'];

    const processed = [];
    for (const order of orders) {
      const tags = order.tags || '';
      const tagList = tags.split(', ').map(t => t.trim().toLowerCase());

      const reps = [];
      for (const tag of tagList) {
        for (const prefix of prefixes) {
          if (tag.startsWith(prefix)) {
            const name = tag.slice(prefix.length);
            if (name && !reps.includes(name) && !excludeReps.includes(name.toLowerCase())) reps.push(name);
          }
        }
      }

      // Skip orders with no tagged reps
      if (reps.length === 0) continue;

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

      for (const rep of reps) {
        const lineItems = order.line_items || [];
        const base = {
          id: order.id,
          name: order.name,
          created_at: order.created_at,
          total_price: parseFloat(order.total_price) || 0,
          subtotal: parseFloat(order.current_subtotal_price) || 0,
          discounts: parseFloat(order.total_discounts) || 0,
          tax: parseFloat(order.total_tax) || 0,
          financial_status: order.financial_status,
          fulfillment_status: order.fulfillment_status,
          source: order.source_name,
          tags: order.tags,
          email: order.email,
          customer: order.customer ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() : '',
          rep: rep.charAt(0).toUpperCase() + rep.slice(1),
          sales_type: salesType
        };

        if (lineItems.length === 0) {
          processed.push({ ...base, vendor: '', item_title: '', item_price: 0, item_qty: 0, line_revenue: 0 });
        } else {
          for (const item of lineItems) {
            processed.push({
              ...base,
              vendor: item.vendor || '',
              item_title: item.title || '',
              item_price: parseFloat(item.price) || 0,
              item_qty: item.quantity || 0,
              line_revenue: (parseFloat(item.price) || 0) * (item.quantity || 0)
            });
          }
        }
      }
    }

    const lastId = orders.length > 0 ? orders[orders.length - 1].id : null;
    const hasMore = orders.length === 250;

    res.status(200).json({ orders: processed, lastId, hasMore, rawCount: orders.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
