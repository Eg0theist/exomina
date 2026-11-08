import { dictationVocabularies, dictationTerms } from './dictation.mjs';

export const DEFAULT_VOICE = Object.freeze({ language: '', voice: '', rate: 0, silenceMs: 1400, previewTone: 'clear', companionMode: 'realtime', dictationMode: 'raw' });
export const AI_VOICE_ACKNOWLEDGMENT = 1;

export function normalizeVoice(value = {}) {
  return {
    language: typeof value.language === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value.language) ? value.language : '',
    voice: typeof value.voice === 'string' && value.voice.length <= 200 && !/[\x00-\x1f]/.test(value.voice) ? value.voice : '',
    rate: Number.isInteger(value.rate) ? Math.max(-5, Math.min(5, value.rate)) : 0,
    silenceMs: [900, 1400, 2200].includes(value.silenceMs) ? value.silenceMs : 1400,
    previewTone: value.previewTone === 'original' ? 'original' : 'clear',
    companionMode: value.companionMode === 'device' ? 'device' : 'realtime',
    dictationMode: value.dictationMode === 'minimal' ? 'minimal' : 'raw',
    ...(value.dictationEngine==='whisper'?{dictationEngine:'whisper'}:{}),
    ...(dictationVocabularies(value.dictationVocabularies).length ? { dictationVocabularies: dictationVocabularies(value.dictationVocabularies) } : {}),
    ...(value.aiVoiceAcknowledged===AI_VOICE_ACKNOWLEDGMENT?{aiVoiceAcknowledged:AI_VOICE_ACKNOWLEDGMENT}:{}),
    ...(typeof value.realtimeVoice==='string'&&/^[a-z]{1,30}$/.test(value.realtimeVoice)?{realtimeVoice:value.realtimeVoice}:{}),
  };
}

const voiceFields=new Set(['language','voice','rate','silenceMs','realtimeVoice','previewTone','companionMode','aiVoiceAcknowledged','dictationMode','dictationVocabulary','dictationEngine']);
/** Apply only the changed control to the host's current value, avoiding stale UI overwrites. */
export function patchVoice(value,patch) {
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!voiceFields.has(key)))throw Error('Invalid voice settings patch.');
  if ('dictationVocabulary' in patch) {
    const item = patch.dictationVocabulary;
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['projectId','terms'].includes(key)) || !/^[A-Za-z0-9_-]{1,100}$/.test(item.projectId || '') || !Array.isArray(item.terms)) throw Error('Invalid project dictation vocabulary.');
    const vocabularies = dictationVocabularies(value?.dictationVocabularies).filter(previous => previous.projectId !== item.projectId);
    const terms = dictationTerms(item.terms);
    if (item.terms.length > 40 || terms.length !== new Set(item.terms.map(term => typeof term === 'string' ? term.toLocaleLowerCase('en-US') : term)).size) throw Error('Preferred spelling must contain up to 40 single words of 3–64 letters, excluding negations.');
    if (terms.length && vocabularies.length >= 32) throw Error('Dictation vocabulary supports up to 32 projects. Remove an unused vocabulary first.');
    if (terms.length) vocabularies.push({projectId:item.projectId,terms});
    const {dictationVocabulary,...rest}=patch;
    return normalizeVoice({...normalizeVoice(value),...rest,dictationVocabularies:vocabularies});
  }
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
