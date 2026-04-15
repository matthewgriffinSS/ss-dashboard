import { put, list } from '@vercel/blob';

export default async function handler(req, res) {
  const results = { write: null, list: null, read: null, errors: [] };

  // Test write
  try {
    const blob = await put('test-blob.json', JSON.stringify({ test: true, time: Date.now() }), { access: 'private', addRandomSuffix: false });
    results.write = { success: true, url: blob.url, downloadUrl: blob.downloadUrl };
  } catch (e) {
    results.write = { success: false };
    results.errors.push('Write error: ' + e.message);
  }

  // Test list
  try {
    const { blobs } = await list({ prefix: 'test-blob' });
    results.list = { success: true, count: blobs.length, blobs: blobs.map(b => ({ url: b.url, downloadUrl: b.downloadUrl, pathname: b.pathname })) };
  } catch (e) {
    results.list = { success: false };
    results.errors.push('List error: ' + e.message);
  }

  // Test read
  try {
    const { blobs } = await list({ prefix: 'test-blob' });
    if (blobs.length > 0) {
      const data = await fetch(blobs[0].downloadUrl).then(r => r.json());
      results.read = { success: true, data };
    } else {
      results.read = { success: false, reason: 'No blobs found' };
    }
  } catch (e) {
    results.read = { success: false };
    results.errors.push('Read error: ' + e.message);
  }

  res.status(200).json(results);
}
