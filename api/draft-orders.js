import { put, head } from '@vercel/blob';
import { getShopifyToken } from './_shopify.js';
import { requireDashAuth } from './_auth.js';

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

// GraphQL returns tags as an array of strings; REST returned comma-separated string.
// Normalize to comma-separated so downstream dashboard code works unchanged.
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

function processDrafts(drafts) {
  const processed = [];
  for (const draft of drafts) {
    const tags = tagsToString(draft.tags);
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
        processed.push({ ...base, vendor: '', item_title: '', item_price: 0, item_qty: 0, line_revenue: 0, line_discount: 0 });
      } else {
        for (const item of lineItems) {
          processed.push({
            ...base,
            vendor: item.vendor || '',
            item_title: item.title || '',
            item_price: item.price,
            item_qty: item.quantity,
            line_revenue: item.price * item.quantity,
            line_discount: item.discount
          });
        }
      }
    }
  }
  return processed;
}

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
      price,
      quantity: qty,
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

const GQL_QUERY = `
  query DraftsByRange($query: String!, $cursor: String) {
    draftOrders(first: 100, after: $cursor, query: $query, sortKey: UPDATED_AT) {
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
          lineItems(first: 100) {
            edges {
              node {
                title
                vendor
                quantity
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

async function fetchDraftsGraphQL(token, store, month, lastDay) {
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

    const connection = json.data?.draftOrders;
    if (!connection) break;

    for (const edge of connection.edges) {
      all.push(normalizeGqlDraft(edge.node));
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
    const lastDay = new Date(y, m, 0).getDate();
    const rawDrafts = await fetchDraftsGraphQL(token, SHOPIFY_STORE, month, lastDay);
    const processed = processDrafts(rawDrafts);

    if (isComplete && processed.length > 0) {
      try {
        await put(blobKey, JSON.stringify(processed), { access: 'public', addRandomSuffix: false });
      } catch (e) { console.error('Cache write error:', e.message); }
    }

    res.status(200).json({ data: processed, source: 'live', month, rawCount: rawDrafts.length });
  } catch (err) {
    res.status(500).json({ error: err.message, month });
  }
}
