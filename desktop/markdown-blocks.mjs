/** Shared block structure for chat rendering and reply exports. Offsets refer to the original text. */
function lines(text) {
  const result = []; let offset = 0;
  for (const value of text.split('\n')) { result.push({ value, start: offset }); offset += value.length + 1; }
  return result;
}
const isTableDivider = value => /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(value);
function cells(line) {
  const parts = []; let value = line.value, base = line.start;
  const lead = value.match(/^\s*\|?/)[0].length; value = value.slice(lead); base += lead;
  let cell = '', cellStart = base;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '|' && value[i - 1] !== '\\') { parts.push({ value: cell, start: cellStart }); cell = ''; cellStart = base + i + 1; }
    else cell += value[i];
  }
  if (cell.trim()) parts.push({ value: cell, start: cellStart });
  return parts.map(part => { const pad = part.value.length - part.value.trimStart().length; return { value: part.value.trim(), start: part.start + pad }; });
}

export function parseBlocks(text) {
  const all = lines(text), blocks = [];
  for (let i = 0; i < all.length;) {
    const line = all[i], value = line.value;
    const fence = value.match(/^(\s*)(```+|~~~+)\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const close = new RegExp(`^\\s*${fence[2][0] === '`' ? '`' : '~'}{${fence[2].length},}\\s*$`);
      let j = i + 1; while (j < all.length && !close.test(all[j].value)) j++;
      const body = all.slice(i + 1, j);
      blocks.push({ type: 'code', language: fence[3], text: body.map(item => item.value).join('\n'), start: body[0]?.start ?? line.start + value.length, languageStart: line.start + value.indexOf(fence[3]) });
      i = Math.min(all.length, j + 1); continue;
    }
    if (!value.trim()) { i++; continue; }
    const heading = value.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, text: heading[2], start: line.start + value.indexOf(heading[2], heading[1].length) }); i++; continue; }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(value)) { blocks.push({ type: 'rule' }); i++; continue; }
    if (/\|/.test(value) && all[i + 1] && isTableDivider(all[i + 1].value)) {
      const head = cells(line); let j = i + 2; const rows = [];
      while (j < all.length && /\|/.test(all[j].value) && all[j].value.trim()) { rows.push(cells(all[j])); j++; }
      blocks.push({ type: 'table', head, rows }); i = j; continue;
    }
    if (/^\s*>/.test(value)) {
      const quoted = []; let j = i;
      while (j < all.length && /^\s*>/.test(all[j].value)) { const prefix = all[j].value.match(/^\s*>\s?/)[0].length; quoted.push({ value: all[j].value.slice(prefix), start: all[j].start + prefix }); j++; }
      blocks.push({ type: 'quote', lines: quoted }); i = j; continue;
    }
    const bullet = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
    if (bullet.test(value)) {
      const ordered = /\d/.test(value.match(bullet)[2]); const items = []; let j = i;
      while (j < all.length) {
        const item = all[j].value.match(bullet);
        if (item && /\d/.test(item[2]) === ordered) { items.push({ depth: Math.floor(item[1].replace(/\t/g, '  ').length / 2), number: ordered ? parseInt(item[2], 10) : null, lines: [{ value: item[3], start: all[j].start + all[j].value.length - item[3].length }] }); j++; }
        else if (items.length && all[j].value.trim() && /^\s{2,}\S/.test(all[j].value) && !bullet.test(all[j].value)) { const pad = all[j].value.match(/^\s*/)[0].length; items[items.length - 1].lines.push({ value: all[j].value.slice(pad), start: all[j].start + pad }); j++; }
        else break;
      }
      blocks.push({ type: 'list', ordered, items }); i = j; continue;
    }
    const paragraph = []; let j = i;
    while (j < all.length && all[j].value.trim() && (j === i || !/^(#{1,6}\s|\s*(?:```|~~~)|\s*>)/.test(all[j].value)) && !(j > i && bullet.test(all[j].value)) && !(/\|/.test(all[j].value) && all[j + 1] && isTableDivider(all[j + 1].value))) { paragraph.push(all[j]); j++; }
    blocks.push({ type: 'paragraph', lines: paragraph }); i = j;
  }
  return blocks;
}
