import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const { key } = req.query;
  
  try {
    if (key) {
      await kv.del(key);
      return res.status(200).json({ cleared: key });
    } else {
      // Clear all cached data
      const keys = await kv.keys('*');
      if (keys.length > 0) {
        await Promise.all(keys.map(k => kv.del(k)));
      }
      return res.status(200).json({ cleared: keys.length + ' keys' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
