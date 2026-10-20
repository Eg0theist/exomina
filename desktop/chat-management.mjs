const SOURCES = new Set(['pending', 'model', 'auto', 'manual']);

export function normalizeChatTitle(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw new Error('Use a single-line chat title of 1–80 characters.');
  const title = value.trim().replace(/\s+/gu, ' ');
  if (!title || Array.from(title).length > 80) throw new Error('Use a single-line chat title of 1–80 characters.');
  return title;
}

/** Only public, portable organization fields; omit absent legacy fields. */
export function chatMetadata(chat) {
  const metadata = {};
  for (const key of ['pinned', 'archived']) if (typeof chat[key] === 'boolean') metadata[key] = chat[key];
  if (Number.isSafeInteger(chat.pinnedOrder) && chat.pinnedOrder >= 0) metadata.pinnedOrder = chat.pinnedOrder;
  if (SOURCES.has(chat.titleSource)) metadata.titleSource = chat.titleSource;
  return metadata;
}

export function prepareConversationTitle(chat) {
  if (!chat.messages?.length && !chat.titleSource && (!chat.title?.trim() || chat.title === 'New chat')) {
    chat.title = 'New chat';
    chat.titleSource = 'pending';
  }
  return chat;
}

export function canAutoTitle(chat) {
  return chat?.archived !== true && chat?.titleSource === 'pending' && chat.title === 'New chat'
    && Array.isArray(chat.messages) && chat.messages.filter(message => message.role === 'user').length === 1;
}

export function compareChats(a, b) {
  const rank = chat => Number.isSafeInteger(chat.pinnedOrder) && chat.pinnedOrder >= 0 ? chat.pinnedOrder : Number.MAX_SAFE_INTEGER;
  return Number(!!b.pinned) - Number(!!a.pinned)
    || (a.pinned && b.pinned ? rank(a) - rank(b) : 0)
    || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)
    || a.id.localeCompare(b.id);
}

/** Freeze the legacy recency order once, then keep replies from moving pins. */
export function orderedPins(conversations) {
  const pins = conversations.filter(chat => chat.pinned).sort(compareChats);
  pins.forEach((chat, index) => { chat.pinnedOrder = index; });
  return pins;
}

export function movePinnedConversation(conversations, {id, direction, targetId, placement}) {
  const targeted = targetId !== undefined;
  if (targeted ? direction !== undefined || !['before', 'after'].includes(placement) : !['up', 'down'].includes(direction)) {
    throw Error(targeted ? 'Choose before or after a pinned chat.' : 'Choose up or down.');
  }
  const chat = conversations.find(item => item.id === id);
  if (!chat?.pinned) throw Error('Pin this chat before moving it.');
  const target = targeted ? conversations.find(item => item.id === targetId) : null;
  if (targeted && (!target?.pinned || !!target.archived !== !!chat.archived)) throw Error('Choose a pinned chat in the same list.');
  const pins = orderedPins(conversations).filter(item => !!item.archived === !!chat.archived);
  if (targeted && target !== chat) {
    // Keep the other list's slots intact, including archived pins between these pins.
    const ranks = pins.map(item => item.pinnedOrder), reordered = pins.filter(item => item !== chat);
    reordered.splice(reordered.indexOf(target) + (placement === 'after' ? 1 : 0), 0, chat);
    reordered.forEach((item, index) => { item.pinnedOrder = ranks[index]; });
  } else if (!targeted) {
    const index = pins.indexOf(chat), adjacent = pins[index + (direction === 'up' ? -1 : 1)];
    if (adjacent) [chat.pinnedOrder, adjacent.pinnedOrder] = [adjacent.pinnedOrder, chat.pinnedOrder];
  }
  return conversations.filter(item => item.pinned);
}

export function updateConversation(chat, action, payload = {}, { active = false, conversations } = {}) {
  if (!chat || typeof chat.id !== 'string') throw new Error('Chat not found.');
  if (action === 'rename') {
    chat.title = normalizeChatTitle(payload.title);
    chat.titleSource = 'manual';
  } else if (action === 'pin') {
    if (typeof payload.pinned !== 'boolean') throw new Error('Choose whether this chat is pinned.');
    if (conversations && payload.pinned && !chat.pinned) chat.pinnedOrder = orderedPins(conversations).length;
    chat.pinned = payload.pinned;
    if (!chat.pinned) delete chat.pinnedOrder;
  } else if (action === 'archive') {
    if (typeof payload.archived !== 'boolean') throw new Error('Choose whether this chat is archived.');
    if (payload.archived && active) throw new Error('Stop this chat before archiving it.');
    chat.archived = payload.archived;
  } else throw new Error('Unknown conversation action.');
  chat.updatedAt = new Date().toISOString();
  return chat;
}
