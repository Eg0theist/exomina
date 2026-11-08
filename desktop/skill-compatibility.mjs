import { createHash } from 'node:crypto';

export const IMPORT_FILES_SCHEMA = { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['name', 'text'], properties: { name: { type: 'string', maxLength: 120 }, text: { type: 'string', maxLength: 24000 } } } };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesHash = value => createHash('sha256').update(value,'utf8').digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;

/** Pure inspection of explicitly supplied text. No file lookup, hooks, network or YAML evaluation. */
export function inspectSkillFiles(files, catalog = []) {
  if (!Array.isArray(files) || !files.length || files.length > 12) throw Error('Supply one to twelve text files.');
  const seen = new Set();
  for (const file of files) {
    if (!file || Object.keys(file).some(key => !['name', 'text'].includes(key)) || typeof file.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(file.name) || seen.has(file.name.toLowerCase()) || typeof file.text !== 'string' || file.text.length > 24000 || file.text.includes('\0')) throw Error('Use unique simple filenames and bounded UTF-8 text, without paths.');
    seen.add(file.name.toLowerCase());
  }
  if (files.reduce((sum, file) => sum + Buffer.byteLength(file.text, 'utf8'), 0) > 128000) throw Error('The import preview exceeds 128 KB.');
  const skill = files.find(file => file.name.toLowerCase() === 'skill.md');
  if (!skill) throw Error('Include SKILL.md in the preview.');
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill.text);
  const rawScalar = key => front?.[1].match(new RegExp('^' + key + ':[ \\t]*(.*)$', 'mi'))?.[1]?.trim() || '';
  const scalar = key => {
    const value = rawScalar(key);
    return /^[|>!&*{[]/.test(value) ? '' : value.replace(/^(["'])(.*)\1$/, '$2');
  };
  // A tiny token/list parser, not YAML: preserve unsupported frontmatter for
  // review instead of silently claiming that no capabilities were requested.
  const rawTools=rawScalar('allowed-tools'),toolValue=rawTools.startsWith('[')&&/^\[[^\[\]\r\n]*\]$/.test(rawTools)?rawTools.slice(1,-1):scalar('allowed-tools');
  const requested=[...new Set(toolValue.split(/[ ,]+/).filter(Boolean).map(value=>value.replace(/^(["'])(.*)\1$/,'$2')))];
  const simpleTools=requested.length<=40&&requested.every(name=>/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(name));
  if(!simpleTools)requested.length=0;
  const names = new Set(catalog.map(tool => tool.name));
  const unsupported = requested.filter(name => !names.has(name));
  const joined = files.map(file => file.text).join('\n'), flags = [];
  if((rawTools&&!simpleTools)||rawTools&&!toolValue||front&&/^allowed-tools:[ \t]*(?:\r?\n|$)/mi.test(front[1]))flags.push('Tool requests use unsupported metadata syntax or exceed the preview limit. Inspect allowed-tools in the retained source; missing requirements may not be listed.');
  if (/\b(?:hooks|mcpServers|mcp_servers|command|args)\s*[":=]/i.test(joined) || files.some(file => /\.(?:mjs|js|cjs|ps1|sh|py|ya?ml)$/i.test(file.name))) flags.push('Executable hooks, scripts or service configuration require separate setup. This preview never installs them.');
  if (/\b(?:ignore|override|bypass)\b.{0,60}\b(?:instructions|permissions|approval|policy)\b/i.test(joined)) flags.push('Possible instruction override in supplied text. Review it as untrusted source material.');
  if (front && /(?:^|\n)(?:[ \t]+\S|[A-Za-z_-]+:\s*[|>!&*])/m.test(front[1])) flags.push('Complex frontmatter is retained as text; only simple scalar metadata is interpreted.');
  const links = [...new Set(joined.match(/https?:\/\/[^\s<>"')\]]+/g) || [])].slice(0, 30);
  const license = files.find(file => /^licen[cs]e(?:\.|$)/i.test(file.name));
  const references = files.filter(file => file !== skill).map(file => ({ name: file.name.slice(0, 80), text: file.text }));
  if (references.some(ref => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(ref.name)) || new Set(references.map(ref => ref.name.toLowerCase())).size !== references.length) throw Error('Reference filenames must remain unique within 80 characters.');
  return { previewHash: hash(files), files: files.map(file => ({ name: file.name, sha256: bytesHash(file.text), characters: file.text.length })), requestedTools: requested.map(name => ({ name, available: names.has(name) })), unsupportedTools: unsupported, flags, destinationsMentioned: links, license: license ? { supplied: true, name: license.name, notice: 'Supplied licence text needs review; compatibility was not certified.' } : { supplied: false, notice: 'No licence file supplied. Reuse rights remain unverified.' }, candidate: { name: (scalar('name') || 'Imported skill').slice(0, 80), description: (scalar('description') || 'Imported instructions for review.').slice(0, 400), instructions: skill.text, references, caveat: 'Imported text only. Dependencies, rights and behavior require review. No scripts, hooks or services were installed.' }, notice: 'Text compatibility preview only, not a safety certification. Availability grants no permission. Save selected instructions through the normal skill create/revise controls.' };
}

export function toolContracts(tools = [], catalog = [], scope = '') {
  const byName = new Map(catalog.map(tool => [tool.name, tool]));
  const contracts = tools.map(name => {
    const tool = byName.get(name);
    return { name, status: tool ? 'available' : 'unavailable', ...(tool ? { schemaHash: hash(stable({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) } : {}) };
  });
  return { fingerprint: hash({ scope, contracts }), tools: contracts, notice: 'Tool definitions are pinned for this checklist. Exact calls still require current permissions; availability does not authorize execution.' };
}
