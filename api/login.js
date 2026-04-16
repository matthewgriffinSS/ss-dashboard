// POST /api/login with { password } body.
// If DASHBOARD_PASSWORD is unset, returns { required: false } (open access).
// If set and correct, returns { ok: true }. If wrong, 401.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const expected = process.env.DASHBOARD_PASSWORD;

  // GET: just report whether password is required
  if (req.method === 'GET') {
    return res.status(200).json({ required: !!expected });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!expected) {
    return res.status(200).json({ ok: true, required: false });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const provided = body?.password;

  if (provided !== expected) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  return res.status(200).json({ ok: true });
}
