export function validQuantity(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 100;
}

export function localDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TZ || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function mondayDateKey(date = new Date()) {
  const key = localDateKey(date);
  const utc = new Date(`${key}T12:00:00Z`);
  const day = utc.getUTCDay();
  utc.setUTCDate(utc.getUTCDate() - ((day + 6) % 7));
  return utc.toISOString().slice(0, 10);
}

export function badgeFor(points, choresDone) {
  if (points >= 100 || choresDone >= 12) return { name: 'Chore Champion', emoji: '🏆' };
  if (points >= 50 || choresDone >= 6) return { name: 'Super Helper', emoji: '⭐' };
  if (points > 0) return { name: 'First Spark', emoji: '✨' };
  return { name: 'Ready to start', emoji: '🌱' };
}
