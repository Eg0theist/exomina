import { parseBlocks } from './markdown-blocks.mjs';
import { INLINE } from './markdown-inline.mjs';

export const REPLY_EXPORT_LIMITS = Object.freeze({ maxCharacters: 1_000_000, maxCells: 100_000, maxTables: 64, maxColumns: 256, maxPackageBytes: 32 * 1024 * 1024 });
const encoder = new TextEncoder();
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const relNS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeRel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const wordNS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const sheetNS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const xml = value => String(value).toWellFormed().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFE\uFFFF]/g, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function sourceText(text) {
  if (typeof text !== 'string' || !text.trim()) throw Error('Choose a reply containing text.');
  if (text.length > REPLY_EXPORT_LIMITS.maxCharacters) throw Error('This reply is too large to export. Save a shorter section instead.');
  return text.replace(/\r\n?/g, '\n');
}
export function replyExportInfo(text) {
  if (typeof text !== 'string' || !text.trim()) return { available: false, tables: 0 };
  if (text.length > REPLY_EXPORT_LIMITS.maxCharacters) return { available: false, tables: 0, reason: 'This reply exceeds the export size limit.' };
  return { available: true, tables: parseBlocks(text.replace(/\r\n?/g, '\n')).filter(block => block.type === 'table').length };
}

/** Formatting is data: no HTML, link target, formula or script is evaluated. */
function segments(source, style = {}, depth = 0) {
  if (depth > 6) return [{ text: source, ...style }];
  const pattern = new RegExp(INLINE.source, INLINE.flags);
  const literal = text => text.replace(/\\([\\`*_{}\[\]()#+.!|>~-])/g, '$1');
  const result = []; let cursor = 0, match;
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) result.push({ text: literal(source.slice(cursor, match.index)), ...style });
    if (match[1]) result.push({ text: match[2], ...style, code: true });
    else if (match[3] !== undefined || match[4] !== undefined) result.push(...segments(match[3] ?? match[4], { ...style, bold: true }, depth + 1));
    else if (match[6] !== undefined || match[7] !== undefined) result.push(...segments(match[6] ?? match[7], { ...style, italic: true }, depth + 1));
    else if (match[5] !== undefined) result.push(...segments(match[5], { ...style, strike: true }, depth + 1));
    else if (match[8] !== undefined) {
      result.push(...segments(match[8], style, depth + 1));
      const target = match[9].trim().replace(/^<(.*)>$/, '$1');
      if (target !== match[8]) result.push({ text: ` (${target})`, ...style });
    }
    else result.push({ text: match[10], ...style });
    cursor = pattern.lastIndex;
  }
  if (cursor < source.length) result.push({ text: literal(source.slice(cursor)), ...style });
  return result;
}
const plain = text => segments(text).map(part => part.text).join('');
const joined = block => block.lines.map(line => line.value).join('\n');

function tableRows(block, limited = true) {
  const rows = [block.head, ...block.rows];
  const columns = rows.reduce((n, row) => Math.max(n, row.length), 0);
  if (!columns || limited && columns > REPLY_EXPORT_LIMITS.maxColumns) throw Error('A table has too many columns to export.');
  if (limited && rows.length * columns > REPLY_EXPORT_LIMITS.maxCells) throw Error('A table exceeds the export cell limit.');
  return rows.map(row => Array.from({ length: columns }, (_, i) => plain(row[i]?.value || '')));
}

// Small, deterministic ZIP32 packages with stored entries. Office needs no compression.
// Fixed package paths are supplied below; file names never come from reply text.
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function packageZip(entries) {
  const files = entries.map(([name, text]) => { const data = encoder.encode(text); return { name: encoder.encode(name), data, crc: crc32(data) }; });
  const length = files.reduce((n, f) => n + 30 + f.name.length + f.data.length + 46 + f.name.length, 22);
  if (length > REPLY_EXPORT_LIMITS.maxPackageBytes) throw Error('The exported document exceeds the size limit. Save a shorter reply.');
  const bytes = new Uint8Array(length), view = new DataView(bytes.buffer); let offset = 0;
  const u16 = (at, n) => view.setUint16(at, n, true), u32 = (at, n) => view.setUint32(at, n, true);
  for (const file of files) {
    file.offset = offset;
    u32(offset, 0x04034b50); u16(offset + 4, 20); u16(offset + 6, 0x800); u16(offset + 12, 33);
    u32(offset + 14, file.crc); u32(offset + 18, file.data.length); u32(offset + 22, file.data.length); u16(offset + 26, file.name.length);
    offset += 30; bytes.set(file.name, offset); offset += file.name.length; bytes.set(file.data, offset); offset += file.data.length;
  }
  const centralOffset = offset;
  for (const file of files) {
    u32(offset, 0x02014b50); u16(offset + 4, 20); u16(offset + 6, 20); u16(offset + 8, 0x800); u16(offset + 14, 33);
    u32(offset + 16, file.crc); u32(offset + 20, file.data.length); u32(offset + 24, file.data.length); u16(offset + 28, file.name.length); u32(offset + 42, file.offset);
    offset += 46; bytes.set(file.name, offset); offset += file.name.length;
  }
  const centralSize = offset - centralOffset;
  u32(offset, 0x06054b50); u16(offset + 8, files.length); u16(offset + 10, files.length); u32(offset + 12, centralSize); u32(offset + 16, centralOffset);
  return bytes;
}
const relationships = items => declaration + `<Relationships xmlns="${relNS}">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${officeRel}${type}" Target="${target}"/>`).join('')}</Relationships>`;
const contentTypes = overrides => declaration + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.map(([name, type]) => `<Override PartName="/${name}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`).join('')}</Types>`;

function wordText(text) { return text.split(/(\n|\t)/).map(part => part === '\n' ? '<w:br/>' : part === '\t' ? '<w:tab/>' : `<w:t xml:space="preserve">${xml(part)}</w:t>`).join(''); }
function wordRuns(text, style = {}) {
  return segments(text, style).map(part => {
    const properties = [part.code && '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>', part.bold && '<w:b/>', part.italic && '<w:i/>', part.strike && '<w:strike/>'].filter(Boolean).join('');
    return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}${wordText(part.text)}</w:r>`;
  }).join('');
}
function paragraph(text, style = 'Normal', prefix = '', depth = 0, code = false) {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${depth ? `<w:ind w:left="${Math.min(depth, 12) * 360}"/>` : ''}</w:pPr>${prefix ? `<w:r><w:t xml:space="preserve">${xml(prefix)}</w:t></w:r>` : ''}${code ? `<w:r>${wordText(text)}</w:r>` : wordRuns(text)}</w:p>`;
}
function wordDocument(blocks) {
  let cellCount = 0;
  const body = blocks.map(block => {
    if (block.type === 'heading') return paragraph(block.text, `Heading${block.level}`);
    if (block.type === 'code') return block.text.split('\n').map(line => paragraph(line, 'Code', '', 0, true)).join('');
    if (block.type === 'quote') return paragraph(joined(block), 'Quote');
    if (block.type === 'list') return block.items.map(item => paragraph(joined(item), 'Normal', block.ordered ? `${item.number}. ` : '• ', item.depth + 1)).join('');
    if (block.type === 'rule') return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/></w:pBdr></w:pPr></w:p>';
    if (block.type === 'table') {
      const rows = [block.head, ...block.rows], columns = rows.reduce((n, row) => Math.max(n, row.length), 0);
      cellCount += rows.length * columns;
      if (!columns || columns > 63 || cellCount > REPLY_EXPORT_LIMITS.maxCells) throw Error('A table exceeds Word’s export limits. Use Excel for wide tables.');
      const width = Math.floor(9360 / columns);
      return `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders>${['top','left','bottom','right','insideH','insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:color="CBD5E1"/>`).join('')}</w:tblBorders></w:tblPr><w:tblGrid>${Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${rows.map((row, r) => `<w:tr>${r === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${Array.from({ length: columns }, (_, c) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${r === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="E8EEF5"/>' : ''}</w:tcPr><w:p>${wordRuns(row[c]?.value || '', { bold: r === 0 })}</w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl><w:p/>`;
    }
    return paragraph(joined(block));
  }).join('');
  const styles = declaration + `<w:styles xmlns:w="${wordNS}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${Array.from({ length: 6 }, (_, i) => `<w:style w:type="paragraph" w:styleId="Heading${i + 1}"><w:name w:val="heading ${i + 1}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${i}"/></w:pPr><w:rPr><w:b/><w:color w:val="24445D"/><w:sz w:val="${[36,30,26,24,22,22][i]}"/></w:rPr></w:style>`).join('')}<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="526477"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/><w:spacing w:after="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style></w:styles>`;
  return packageZip([
    ['[Content_Types].xml', contentTypes([['word/document.xml','wordprocessingml.document.main'], ['word/styles.xml','wordprocessingml.styles']])],
    ['_rels/.rels', relationships([['rId1','officeDocument','word/document.xml']])],
    ['word/_rels/document.xml.rels', relationships([['rId1','styles','styles.xml']])],
    ['word/styles.xml', styles],
    ['word/document.xml', declaration + `<w:document xmlns:w="${wordNS}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1273" w:right="1273" w:bottom="1273" w:left="1273" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`],
  ]);
}

function columnName(index) { let name = ''; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name; return name; }
function sheetName(title, index, used) {
  let base = plain(title || '').replace(/[\\/*?:\[\]\u0000-\u001f]/g, ' ').trim().slice(0, 31).replace(/^'+|'+$/g, '').trim() || `Table ${index + 1}`;
  if (base.toLowerCase() === 'history') base = 'History table';
  let name = base, suffix = 1;
  while (used.has(name.toLowerCase())) { const tail = ` (${++suffix})`; name = base.slice(0, 31 - tail.length) + tail; }
  used.add(name.toLowerCase()); return name;
}
function excelCell(value, r, c, strings) {
  if (value === '') return '';
  if (value.length > 32767) throw Error('A cell exceeds Excel’s 32,767-character limit. Save this reply as Word or Markdown.');
  const ref = columnName(c) + (r + 1), style = r === 0 ? ' s="1"' : '';
  const numeric = r > 0 && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && value.replace(/[-.]/g, '').length <= 15 && String(Number(value)) === value;
  // Everything else, including =, +, -, @, URLs and leading zeroes, is literal text.
  if (numeric) return `<c r="${ref}" t="n"${style}><v>${value}</v></c>`;
  if (!strings.index.has(value)) { strings.index.set(value, strings.values.length); strings.values.push(value); }
  strings.count++;
  return `<c r="${ref}" t="s"${style}><v>${strings.index.get(value)}</v></c>`;
}
function excelDocument(blocks) {
  const tables = []; let heading = '', cells = 0;
  for (const block of blocks) {
    if (block.type === 'heading') heading = block.text;
    if (block.type === 'table') { const rows = tableRows(block); cells += rows.length * rows[0].length; tables.push({ title: heading, rows }); }
  }
  if (!tables.length) throw Error('Excel export needs a table in the reply. Ask the AI to put your data in a table first.');
  if (tables.length > REPLY_EXPORT_LIMITS.maxTables || cells > REPLY_EXPORT_LIMITS.maxCells) throw Error('The reply exceeds the spreadsheet export limits. Save fewer tables at a time.');
  const names = new Set();
  const sheets = tables.map((table, i) => ({ ...table, name: sheetName(table.title, i, names), id: i + 1 }));
  const strings = { index: new Map(), values: [], count: 0 };
  const worksheets = sheets.map(sheet => {
    const rows = sheet.rows, columns = rows[0].length, end = columnName(columns - 1) + rows.length;
    const widths = Array.from({ length: columns }, (_, c) => Math.min(60, Math.max(12, ...rows.slice(0, 200).map(row => row[c].length + 2))));
    return [`xl/worksheets/sheet${sheet.id}.xml`, declaration + `<worksheet xmlns="${sheetNS}"><dimension ref="A1:${end}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((width, c) => `<col min="${c + 1}" max="${c + 1}" width="${width}" customWidth="1"/>`).join('')}</cols><sheetData>${rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => excelCell(value, r, c, strings)).join('')}</row>`).join('')}</sheetData><autoFilter ref="A1:${end}"/></worksheet>`];
  });
  const styles = declaration + `<styleSheet xmlns="${sheetNS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF24445D"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF5"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  return packageZip([
    ['[Content_Types].xml', contentTypes([['xl/workbook.xml','spreadsheetml.sheet.main'],['xl/styles.xml','spreadsheetml.styles'],['xl/sharedStrings.xml','spreadsheetml.sharedStrings'], ...sheets.map(sheet => [`xl/worksheets/sheet${sheet.id}.xml`,'spreadsheetml.worksheet'])])],
    ['_rels/.rels', relationships([['rId1','officeDocument','xl/workbook.xml']])],
    ['xl/workbook.xml', declaration + `<workbook xmlns="${sheetNS}" xmlns:r="${officeRel.slice(0, -1)}"><sheets>${sheets.map(sheet => `<sheet name="${xml(sheet.name)}" sheetId="${sheet.id}" r:id="rId${sheet.id}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', relationships([...sheets.map(sheet => [`rId${sheet.id}`,'worksheet',`worksheets/sheet${sheet.id}.xml`]),[`rId${sheets.length + 1}`,'styles','styles.xml'],[`rId${sheets.length + 2}`,'sharedStrings','sharedStrings.xml']])],
    ['xl/styles.xml', styles],
    ['xl/sharedStrings.xml', declaration + `<sst xmlns="${sheetNS}" count="${strings.count}" uniqueCount="${strings.values.length}">${strings.values.map(value => `<si><t xml:space="preserve">${xml(value.replace(/_x[0-9a-fA-F]{4}_/g, match => '_x005F_' + match.slice(1)))}</t></si>`).join('')}</sst>`],
    ...worksheets,
  ]);
}
function textDocument(blocks) {
  return blocks.map(block => {
    if (block.type === 'code') return block.text;
    if (block.type === 'heading') return plain(block.text);
    if (block.type === 'rule') return '---';
    if (block.type === 'table') return tableRows(block, false).map(row => row.join('\t')).join('\n');
    if (block.type === 'list') return block.items.map(item => `${'  '.repeat(Math.min(item.depth, 12))}${block.ordered ? item.number + '.' : '•'} ${plain(joined(item))}`).join('\n');
    return plain(joined(block));
  }).join('\n\n') + '\n';
}

/** No filesystem, network, Office installation or additional runtime is needed. */
export function createReplyExport({ text, format } = {}) {
  if (!['docx','xlsx','md','txt'].includes(format)) throw Error('Choose Word, Excel, Markdown or plain text.');
  const source = sourceText(text), blocks = parseBlocks(source);
  const bytes = format === 'docx' ? wordDocument(blocks) : format === 'xlsx' ? excelDocument(blocks) : encoder.encode(format === 'md' ? source : textDocument(blocks));
  return { filename: `Exomina-reply.${format}`, mimeType: { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', md: 'text/markdown;charset=utf-8', txt: 'text/plain;charset=utf-8' }[format], bytes };
}
