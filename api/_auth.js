// Checks x-admin-key header against ADMIN_KEY env var.
// Returns true if authorized, false otherwise (and writes 401 to res).
export function requireAdmin(req, res) {
  const expected = process.env.ADMIN_KEY;
  if (!expected) {
    res.status(500).json({ error: 'ADMIN_KEY not configured' });
    return false;
  }
  const provided = req.headers['x-admin-key'];
  if (provided !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Checks x-dash-key header against DASHBOARD_PASSWORD env var.
// If DASHBOARD_PASSWORD is unset, access is open (backwards compatible).
export function requireDashAuth(req, res) {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) return true; // no password configured -> open access
  const provided = req.headers['x-dash-key'];
  if (provided !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

