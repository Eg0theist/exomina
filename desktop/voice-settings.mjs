export const DEFAULT_VOICE = Object.freeze({ language: '', voice: '', rate: 0, silenceMs: 1400, previewTone: 'clear' });

export function normalizeVoice(value = {}) {
  return {
    language: typeof value.language === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value.language) ? value.language : '',
    voice: typeof value.voice === 'string' && value.voice.length <= 200 && !/[\x00-\x1f]/.test(value.voice) ? value.voice : '',
    rate: Number.isInteger(value.rate) ? Math.max(-5, Math.min(5, value.rate)) : 0,
    silenceMs: [900, 1400, 2200].includes(value.silenceMs) ? value.silenceMs : 1400,
    previewTone: value.previewTone === 'original' ? 'original' : 'clear',
    ...(typeof value.realtimeVoice==='string'&&/^[a-z]{1,30}$/.test(value.realtimeVoice)?{realtimeVoice:value.realtimeVoice}:{}),
  };
}

const voiceFields=new Set(['language','voice','rate','silenceMs','realtimeVoice','previewTone']);
/** Apply only the changed control to the host's current value, avoiding stale UI overwrites. */
export function patchVoice(value,patch) {
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!voiceFields.has(key)))throw Error('Invalid voice settings patch.');
  return normalizeVoice({...normalizeVoice(value),...patch});
}

/** Speak prose, keeping long code blocks and destination URLs out of the audio. */
export function spokenText(value) {
  return String(value || '').replace(/```[\s\S]*?```/g, ' Code example omitted. ')
    .replace(/~~~[\s\S]*?~~~/g, ' Code example omitted. ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*[#>|]+\s*/gm, '').replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 24000);
}
