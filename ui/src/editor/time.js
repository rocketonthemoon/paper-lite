// Time formatting for the editor (pure: no DOM or storage, so it is unit-testable in Node).
export const clock = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }); };
// "14:05" for today, "Nov 27 14:05" for other days (plus the year when it isn't this year).
export const stamp = (iso, now = new Date()) => {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  if (d.toDateString() === now.toDateString()) return clock(iso);
  const opts = { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) };
  return `${d.toLocaleDateString([], opts)} ${clock(iso)}`;
};
// Full local date and time with seconds, for tooltips.
export const fullStamp = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? "" : d.toLocaleString([], { dateStyle: "medium", timeStyle: "medium", hour12: false }); };
