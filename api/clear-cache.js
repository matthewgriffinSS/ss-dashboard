import { list, del } from '@vercel/blob';
import { requireAdmin } from './_auth.js';

// Matches any cache blob we manage: monthly order or draft files only.
// Keep this strict so the endpoint can't touch anything else in the blob store.
const CACHE_KEY_RE = /^(orders|drafts)-\d{4}-\d{2}\.json$/;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!requireAdmin(req, res)) return;

  try {
    // GET = list all cached blobs with size + timestamp
    if (req.method === 'GET') {
      const { blobs } = await list();
      const cached = blobs
        .filter(b => CACHE_KEY_RE.test(b.pathname))
        .map(b => ({
          key: b.pathname,
          size: b.size,
          uploadedAt: b.uploadedAt,
          url: b.url
        }))
        .sort((a, b) => a.key.localeCompare(b.key));
      return res.status(200).json({ blobs: cached, count: cached.length });
    }

    // DELETE / POST = clear cache
    if (req.method === 'POST' || req.method === 'DELETE') {
      const { key, all } = req.query;

      // Clear one specific key
      if (key) {
        if (!CACHE_KEY_RE.test(key)) {
          return res.status(400).json({ error: 'Invalid key format' });
        }
        const { blobs } = await list({ prefix: key });
        const match = blobs.find(b => b.pathname === key);
        if (!match) return res.status(404).json({ error: 'Not found', key });
        await del(match.url);
        return res.status(200).json({ cleared: [key] });
      }

      // Clear everything
      if (all === '1' || all === 'true') {
        const { blobs } = await list();
        const toDelete = blobs.filter(b => CACHE_KEY_RE.test(b.pathname));
        if (toDelete.length === 0) return res.status(200).json({ cleared: [] });
        await Promise.all(toDelete.map(b => del(b.url)));
        return res.status(200).json({ cleared: toDelete.map(b => b.pathname) });
      }

      return res.status(400).json({ error: 'Provide ?key=... or ?all=1' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
