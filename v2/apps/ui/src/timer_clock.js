// Browser clock and local-time parsing for the timer screens. Display and pause
// inputs only: the server never takes a clock or due time from the page.
const input = await dioxus.recv();
const at = (days, hour) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d.getTime(); };
if (input.op === 'now') return Date.now();
if (input.op === 'parse') { const t = new Date(String(input.value)).getTime(); return Number.isFinite(t) ? t : null; }
if (input.op === 'preset') {
 switch (input.value) {
  case 'hour': return Date.now() + 3600000;
  case 'tomorrow': return at(1, 9);
  case 'week': return at(7, 9);
  case 'forever': return 4102444800000;
 }
}
return null;
