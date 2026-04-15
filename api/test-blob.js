import { put, list, head } from '@vercel/blob';

export default async function handler(req, res) {
  const results = { write: null, head: null, read: null, errors: [] };

  try {
    const blob = await put('test-cache.json', JSON.stringify({ test: true, time: Date.now() }), { addRandomSuffix: false });
    results.write = { success: true, url: blob.url, downloadUrl: blob.downloadUrl };
  } catch (e) {
    results.write = { success: false };
    results.errors.push('Write: ' + e.message);
  }

  try {
    const { blobs } = await list({ prefix: 'test-cache' });
    if (blobs.length > 0) {
      const url = blobs[0].downloadUrl || blobs[0].url;
      const data = await fetch(url).then(r => r.json());
      results.read = { success: true, data, usedUrl: url };
    } else {
      results.read = { success: false, reason: 'No blobs after write' };
    }
  } catch (e) {
    results.read = { success: false };
    results.errors.push('Read: ' + e.message);
  }

  res.status(200).json(results);
}
