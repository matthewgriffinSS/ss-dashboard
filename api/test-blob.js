import { put, list, head } from '@vercel/blob';

export default async function handler(req, res) {
  const results = { write: null, head: null, list: null, read: null, errors: [] };

  // Test write with public
  try {
    const blob = await put('test-cache.json', JSON.stringify({ test: true, time: Date.now() }), { access: 'public', addRandomSuffix: false });
    results.write = { success: true, url: blob.url, downloadUrl: blob.downloadUrl, pathname: blob.pathname };
  } catch (e) {
    results.write = { success: false };
    results.errors.push('Write: ' + e.message);
  }

  // Test head
  try {
    const h = await head('test-cache.json');
    results.head = { success: true, url: h.url, downloadUrl: h.downloadUrl };
  } catch (e) {
    results.head = { success: false };
    results.errors.push('Head: ' + e.message);
  }

  // Test list
  try {
    const { blobs } = await list({ prefix: 'test-cache' });
    results.list = { success: true, count: blobs.length, first: blobs[0] || null };
  } catch (e) {
    results.list = { success: false };
    results.errors.push('List: ' + e.message);
  }

  // Test read via list
  try {
    const { blobs } = await list({ prefix: 'test-cache' });
    if (blobs.length > 0) {
      const url = blobs[0].downloadUrl || blobs[0].url;
      const data = await fetch(url).then(r => r.json());
      results.read = { success: true, data, usedUrl: url };
    }
  } catch (e) {
    results.read = { success: false };
    results.errors.push('Read: ' + e.message);
  }

  res.status(200).json(results);
}
