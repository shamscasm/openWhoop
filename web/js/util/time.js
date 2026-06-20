// Time / date helpers. Local-day keys match the Python "YYYY-MM-DD" daily
// rollup convention used in whoof/db.py.

export function isoUtcNow() {
  return new Date().toISOString();
}

export function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function startOfLocalDay(d = new Date()) {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

export function endOfLocalDay(d = new Date()) {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}
