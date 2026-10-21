/** Parses CSV text into rows of fields: quoted fields may hold commas, newlines and doubled quotes. */
export function parse(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; started = true; }
    else if (ch === ',') { row.push(field); field = ''; started = true; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (started || field) { row.push(field); rows.push(row); }
      row = []; field = ''; started = false;
    } else { field += ch; started = true; }
  }
  if (started || field) { row.push(field); rows.push(row); }
  return rows;
}
