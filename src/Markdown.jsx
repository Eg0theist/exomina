import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { parseChatLink } from '../desktop/chat-links.mjs';
import SelectableText from './SelectableText.jsx';
import { parseBlocks } from '../desktop/markdown-blocks.mjs';
import { INLINE } from '../desktop/markdown-inline.mjs';
export { parseBlocks } from '../desktop/markdown-blocks.mjs';

/** Clipboard write that works without the (denied) clipboard permission. */
export function copyText(text, ownerDocument = document) {
  const area = ownerDocument.createElement('textarea'), focused = ownerDocument.activeElement;
  area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
  ownerDocument.body.appendChild(area); area.select();
  let ok = false; try { ok = ownerDocument.execCommand('copy'); } catch { ok = false; }
  area.remove(); focused?.focus?.({preventScroll:true}); return ok;
}

export function CopyButton({ text, label = 'Copy', className = '' }) {
  const [done, setDone] = useState(false);
  return <button type="button" className={`copy-button ${className}`} aria-label={done ? 'Copied' : label} title={done ? 'Copied' : label} onClick={event => { if (copyText(text,event.currentTarget.ownerDocument)) { setDone(true); setTimeout(() => setDone(false), 1400); } }}>{done ? <Check size={13} /> : <Copy size={13} />}{className.includes('labelled') && <span>{done ? 'Copied' : label}</span>}</button>;
}


/** Renders inline markdown; `mark(text, absoluteStart)` adds search highlights. */
function inline(source, start, mark, onLink, keyBase = '') {
  const output = []; let cursor = 0, index = 0, match;
  const text = source;
  const pattern = new RegExp(INLINE.source, INLINE.flags);
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) output.push(<React.Fragment key={`${keyBase}t${index++}`}>{mark(text.slice(cursor, match.index), start + cursor)}</React.Fragment>);
    const at = start + match.index, key = `${keyBase}i${index++}`;
    if (match[1]) { const offset = match[1].length, url = match[2], body = mark(url, at + offset), link = parseChatLink(url); output.push(<code key={key}>{link ? <a href={url} onClick={event => { if (onLink) { event.preventDefault(); onLink(url); } }} title={url}>{body}</a> : body}</code>); }
    else if (match[3] !== undefined || match[4] !== undefined) { const body = match[3] ?? match[4]; output.push(<strong key={key}>{inline(body, at + 2, mark, onLink, key)}</strong>); }
    else if (match[5] !== undefined) output.push(<del key={key}>{inline(match[5], at + 2, mark, onLink, key)}</del>);
    else if (match[6] !== undefined || match[7] !== undefined) output.push(<em key={key}>{inline(match[6] ?? match[7], at + 1, mark, onLink, key)}</em>);
    else if (match[8] !== undefined) {
      const url = match[9].trim().replace(/^<(.*)>$/, '$1');
      output.push(parseChatLink(url) ? <a key={key} href={url} onClick={event => { if (onLink) { event.preventDefault(); onLink(url); } }} title={url}>{inline(match[8], at + 1, mark, onLink, key)}</a> : <React.Fragment key={key}>{mark(match[0], at)}</React.Fragment>);
    } else if (match[10]) { const url = match[10]; output.push(<a key={key} href={url} onClick={event => { if (onLink) { event.preventDefault(); onLink(url); } }}>{mark(url, at)}</a>); }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) output.push(<React.Fragment key={`${keyBase}t${index++}`}>{mark(text.slice(cursor), start + cursor)}</React.Fragment>);
  return output;
}

function joined(parts, mark, onLink, key) {
  return parts.flatMap((part, index) => [...(index ? [<br key={`${key}b${index}`} />] : []), ...inline(part.value, part.start, mark, onLink, `${key}l${index}`)]);
}

export default function Markdown({ text, mark = value => value, onLink }) {
  const blocks = parseBlocks(String(text || ''));
  return blocks.map((block, index) => {
    const key = `b${index}`;
    if (block.type === 'code') return <div className="code-block" key={key}><div className="code-header"><span className="code-language">{block.language ? mark(block.language, block.languageStart) : 'text'}</span><CopyButton text={block.text} label="Copy code" className="labelled" /></div><SelectableText><code>{mark(block.text, block.start)}</code></SelectableText></div>;
    if (block.type === 'heading') { const Tag = `h${Math.min(6, block.level + 2)}`; return <Tag className={`md-heading md-h${block.level}`} key={key}>{inline(block.text, block.start, mark, onLink, key)}</Tag>; }
    if (block.type === 'rule') return <hr key={key} />;
    if (block.type === 'quote') return <blockquote key={key}>{joined(block.lines, mark, onLink, key)}</blockquote>;
    if (block.type === 'table') return <div className="md-table" key={key}><table><thead><tr>{block.head.map((cell, c) => <th key={c}>{inline(cell.value, cell.start, mark, onLink, `${key}h${c}`)}</th>)}</tr></thead><tbody>{block.rows.map((row, r) => <tr key={r}>{block.head.map((_, c) => <td key={c}>{row[c] ? inline(row[c].value, row[c].start, mark, onLink, `${key}r${r}c${c}`) : null}</td>)}</tr>)}</tbody></table></div>;
    if (block.type === 'list') { const Tag = block.ordered ? 'ol' : 'ul'; return <Tag key={key} start={block.ordered && block.items[0]?.number !== 1 ? block.items[0]?.number : undefined}>{block.items.map((item, n) => <li key={n} style={item.depth ? { marginLeft: `${item.depth * 18}px` } : undefined}>{joined(item.lines, mark, onLink, `${key}i${n}`)}</li>)}</Tag>; }
    return <p key={key}>{joined(block.lines, mark, onLink, key)}</p>;
  });
}
