
const MAX_DRAFTS = 200, MAX_TEXT = 4000;
export const MARKETING_CHANNELS = ['x', 'reddit', 'linkedin', 'blog', 'other'];
const CHANNEL_LIMIT = {x: 280, reddit: 3000, linkedin: 3000, blog: MAX_TEXT, other: MAX_TEXT};
const clip = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

/** Off by default. There is deliberately no setting that disables approval. */
export function marketingSettings(value = {}) {
  const brief = value.brief && typeof value.brief === 'object' ? value.brief : {};
  return {enabled: value.enabled === true, provider: clip(value.provider, 80),
    channels: (Array.isArray(value.channels) ? value.channels : []).filter(c => MARKETING_CHANNELS.includes(c)),
    brief: {product: clip(brief.product, 600), audience: clip(brief.audience, 600), voiceNotes: clip(brief.voiceNotes, 1200), avoid: clip(brief.avoid, 800)}};
}

/** Local writing-style summary from the user's own public text. Numbers and
 *  flags only; the samples themselves never go into this object. */
export function styleProfile(samples) {
  const text = (Array.isArray(samples) ? samples : [samples]).filter(s => typeof s === 'string').join('\n\n').slice(0, 200000);
  const sentences = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const words = text.match(/[\p{L}\p{N}'’-]+/gu) || [];
  if (words.length < 50) return {ready: false, words: words.length};
  const lens = sentences.map(s => (s.match(/[\p{L}\p{N}'’-]+/gu) || []).length);
  const avg = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
  const per100 = re => Math.round((text.match(re) || []).length / words.length * 1000) / 10;
  const german = (text.match(/\b(und|der|die|das|nicht|ist|ein|eine)\b/gi) || []).length > (text.match(/\b(and|the|not|is|a|an)\b/gi) || []).length;
  return {ready: true, words: words.length, language: german ? 'de' : 'en', avgSentenceWords: Math.round(avg * 10) / 10,
    longSentenceShare: Math.round(lens.filter(n => n > 25).length / Math.max(1, lens.length) * 100) / 100,
    questionsPer100Words: per100(/\?/g), emDashesPer100Words: per100(/—/g), semicolonsPer100Words: per100(/;/g),
    usesEmoji: /\p{Extended_Pictographic}/u.test(text), usesExclamations: per100(/!/g) > 0.3};
}

export function styleInstructions(style) {
  if (!style?.ready) return 'No writing samples yet: write plainly and concretely.';
  const lines = [`Write in ${style.language === 'de' ? 'German' : 'English'}.`,
    `Typical sentence length is about ${style.avgSentenceWords} words${style.longSentenceShare > 0.25 ? ', with frequent long sentences' : ''}.`];
  lines.push(style.emDashesPer100Words < 0.1 ? 'Avoid em-dashes.' : 'Em-dashes are acceptable.');
  lines.push(style.usesEmoji ? 'Occasional emoji are acceptable.' : 'No emoji.', style.usesExclamations ? 'Exclamations are acceptable.' : 'Avoid exclamation marks.');
  return lines.join(' ');
}

/** Only public inputs (brief, release notes, style numbers) enter the prompt. */
export function draftPrompt({brief, style, releaseNotes, channel, count = 3}) {
  const limit = CHANNEL_LIMIT[channel] || MAX_TEXT;
  return [`Draft ${Math.min(5, Math.max(1, count))} distinct ${channel} posts, each at most ${limit} characters.`,
    `Product: ${brief.product || 'unspecified'}\nAudience: ${brief.audience || 'unspecified'}`,
    brief.voiceNotes && `Voice: ${brief.voiceNotes}`, `Style: ${styleInstructions(style)}`,
    brief.avoid && `Never mention or imitate: ${brief.avoid}`,
    'Only claim features that appear in the release notes below. Do not invent numbers, testimonials or quotes.',
    '<release-notes>\n' + clip(releaseNotes, 8000).replace(/<\/?release-notes>/gi, '') + '\n</release-notes>',
    'Reply only with JSON: {"drafts":[{"text":"...","reason":"which release note it is based on"}]}'].filter(Boolean).join('\n\n');
}

export function parseDrafts(text, channel) {
  const json = String(text || '').match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error('The model did not return structured drafts.');
  let parsed; try { parsed = JSON.parse(json); } catch { throw new Error('The model did not return structured drafts.'); }
  const limit = CHANNEL_LIMIT[channel] || MAX_TEXT;
  const drafts = (Array.isArray(parsed.drafts) ? parsed.drafts : []).map(d => ({text: clip(d?.text, MAX_TEXT), reason: clip(d?.reason, 400)}))
    .filter(d => d.text && d.text.length <= limit);
  if (!drafts.length) throw new Error('No draft fit the channel limit.');
  return drafts;
}

/** Approval queue. Nothing here can publish: the only exits are copy-out by the
 *  user and the user's own confirmation that they posted it. */
export class MarketingQueue {
  constructor({store, now = () => new Date()}) { this.store = store; this.now = now; }
  get items() { return (this.store.state.marketingDrafts ||= []); }
  async add(channel, drafts, source = '') {
    if (!MARKETING_CHANNELS.includes(channel)) throw new Error('Unknown channel.');
    for (const d of drafts) this.items.unshift({id: globalThis.crypto.randomUUID(), channel, text: d.text, reason: d.reason || '', source: clip(source, 200), status: 'pending', createdAt: this.now().toISOString()});
    this.items.length = Math.min(this.items.length, MAX_DRAFTS);
    await this.store.save();
  }
  find(id) { const item = this.items.find(i => i.id === id); if (!item) throw new Error('Draft not found.'); return item; }
  async edit(id, text) {
    const item = this.find(id), next = clip(text, CHANNEL_LIMIT[item.channel]);
    if (!next) throw new Error('Draft text is empty.');
    if (item.status === 'posted') throw new Error('Posted drafts are final.');
    item.text = next; item.status = 'pending'; delete item.approvedAt; await this.store.save();
  }
  async approve(id) {
    const item = this.find(id);
    if (item.status !== 'pending') throw new Error('Only pending drafts can be approved.');
    item.status = 'approved'; item.approvedAt = this.now().toISOString(); await this.store.save();
  }
  async reject(id) { const item = this.find(id); if (item.status === 'posted') throw new Error('Posted drafts are final.'); item.status = 'rejected'; await this.store.save(); }
  /** The user states they posted it themselves; Exomina never posts. */
  async markPosted(id) {
    const item = this.find(id);
    if (item.status !== 'approved') throw new Error('Approve the draft before marking it posted.');
    item.status = 'posted'; item.postedAt = this.now().toISOString(); await this.store.save();
  }
  /** Rejected drafts become negative examples for later runs. */
  feedback() { return this.items.filter(i => ['approved', 'posted', 'rejected'].includes(i.status)).slice(0, 40).map(i => ({channel: i.channel, liked: i.status !== 'rejected', text: i.text.slice(0, 300)})); }
}
