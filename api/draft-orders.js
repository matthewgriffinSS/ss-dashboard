import { put, head } from '@vercel/blob';
import { getShopifyToken } from './_shopify.js';
import { requireDashAuth } from './_auth.js';

const VALID_REPS = ['boggs','bowman','bryan','griffin','hector','jeff','joe','nick'];

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

const DRAFTS_QUERY = `
  query DraftsByRange($query: String!, $cursor: String) {
    draftOrders(first: 50, after: $cursor, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          status
          createdAt
          updatedAt
          invoiceSentAt
          tags
          subtotalPriceSet { shopMoney { amount } }
          order { id }
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

function normalizeGqlDraft(node) {
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
      line_revenue: discounted,
      discount: Math.max(0, gross - discounted)
    };
  });

  return {
    id: idFromGid(node.id),
    name: node.name || '',
    status: (node.status || '').toLowerCase(),
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    subtotal: parseFloat(node.subtotalPriceSet?.shopMoney?.amount || 0),
    invoice_sent_at: node.invoiceSentAt,
    tags: node.tags || [],
    order: node.order ? { id: idFromGid(node.order.id) } : null,
    line_items: lineItems
  };
}

function processDrafts(drafts) {
  const processed = [];
  for (const draft of drafts) {
    const tags = tagsToString(draft.tags);
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
    const salesType = classifySalesType(tags);
    const converted = !!draft.order;
    for (const rep of reps) {
      const base = {
        id: draft.id, name: draft.name, status: draft.status,
        created_at: draft.created_at, updated_at: draft.updated_at,
        subtotal: draft.subtotal,
        invoice_sent_at: draft.invoice_sent_at, tags: tags,
        converted, rep: rep.charAt(0).toUpperCase() + rep.slice(1),
        sales_type: salesType
      };
      const lineItems = draft.line_items || [];
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

function nextMonthStart(year, month) {
  if (month === 12) return `${year + 1}-01-01`;
  return `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

async function fetchDraftsGraphQL(token, store, month, year, monthNum) {
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
        body: JSON.stringify({ query: DRAFTS_QUERY, variables: { query: queryStr, cursor } }),
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('Shopify drafts request timed out');
      throw e;
    }
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Drafts GraphQL ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = await res.json();
    if (json.errors) {
      throw new Error('Drafts GraphQL errors: ' + JSON.stringify(json.errors).slice(0, 500));
    }

    if (json.extensions?.cost?.throttleStatus) lastCost = json.extensions.cost;

    const connection = json.data?.draftOrders;
    if (!connection) break;
    for (const edge of connection.edges) all.push(normalizeGqlDraft(edge.node));

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

  return { drafts: all, lastCost };
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
  const blobKey = `drafts-${month}.json`;

  if (isComplete) {
    try {
      const blob = await head(blobKey);
      if (blob && blob.url) {
        const cached = await fetch(blob.url).then(r => r.json());
        return res.status(200).json({ data: cached, source: 'cache', month });
      }
    } catch (e) {}
  }

  try {
    const token = await getShopifyToken();
    const { drafts: rawDrafts, lastCost } = await fetchDraftsGraphQL(token, SHOPIFY_STORE, month, y, m);
    const processed = processDrafts(rawDrafts);

    if (isComplete && processed.length > 0) {
      try {
        await put(blobKey, JSON.stringify(processed), { access: 'public', addRandomSuffix: false });
      } catch (e) { console.error('Cache write error:', e.message); }
    }

    res.status(200).json({
      data: processed,
      source: 'live',
      month,
      rawCount: rawDrafts.length,
      costInfo: lastCost
    });
  } catch (err) {
    res.status(500).json({ error: err.message, month });
  }
}
