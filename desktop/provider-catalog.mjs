// Public connection metadata. This module is safe to import in the renderer.
import {DISTRIBUTION_PROFILE} from './distribution.mjs';
// API model IDs deliberately have no default: access, pricing and tool support vary.
const api = (entry) => ({
  engine: 'OpenAI-compatible API', mode: 'api', authType: 'apiKey',
  protocol: 'openai', defaultModel: '', models: [], ...entry,
});

export const PROVIDER_CATALOG = Object.freeze([
  {
    id: 'codex', name: 'ChatGPT', engine: 'Codex', mode: 'subscription',
    authType: 'official', defaultModel: '', models: [], baseUrl: '',
    description: 'Official ChatGPT sign-in through the included Codex runtime.',
    billingNote: 'Your eligible ChatGPT plan and Codex limits apply. Provider-enabled extra usage may cost more; Exomina never switches this connection to an API key.',
    setupUrl: 'https://learn.chatgpt.com/docs/auth',
  },
  DISTRIBUTION_PROFILE === 'beta' ? {
    // Shared builds ship nothing from Anthropic. The user turns this on, which
    // uses (or installs from Anthropic) their own unmodified Claude Code.
    id: 'claude', name: 'Claude', engine: 'Claude Code', mode: 'subscription',
    authType: 'official', defaultModel: '', models: [], baseUrl: '', optIn: true,
    description: 'Use your Claude plan through your own copy of Anthropic’s Claude Code. Off until you turn it on.',
    billingNote: 'Your Claude plan’s limits apply. Claude Code is installed from Anthropic and signed in through Anthropic’s own page; Exomina never sees your password.',
    setupUrl: 'https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use',
  } : {
    id: 'claude', name: 'Claude', engine: 'Claude Code', mode: 'subscription',
    authType: 'official', defaultModel: '', models: [], baseUrl: '',
    description: 'Official Claude account sign-in through the included Claude Code runtime.',
    billingNote: 'Claude account entitlements, programmatic-use credits and limits apply. Provider-enabled extra usage may cost more; Exomina never switches this connection to an API key.',
    setupUrl: 'https://code.claude.com/docs/en/authentication',
  },
  {
    id: 'antigravity', name: 'Gemini', engine: 'Antigravity CLI', mode: 'subscription',
    aliases: ['Antigravity', 'agy'],
    authType: 'official', defaultModel: '', models: [], baseUrl: '', accent: '#8fb4ff',
    description: 'Use Gemini models with your personal Google AI Pro, Ultra or free Google account, through Google’s Antigravity CLI.',
    billingNote: 'Your Google plan’s access and limits apply. Sign in through Google’s own CLI in Exomina’s protected profile. Shared browser, memory, questions and attached files use Exomina’s permission controls. Images are read through the attachment tool; direct image input in tool-free helpers is unavailable. Automatic Google credits are disabled, and this connection never switches to an API key.',
    setupUrl: 'https://antigravity.google/docs/cli/install/',
    mediaWebsite: { url: 'https://gemini.google.com/app', label: 'Open Gemini for images & videos', detail: "Google's image and video tools are available on Gemini's website according to your plan. This chat connection uses Antigravity CLI, which has no built-in image or video generator." },
  },
  {
    id: 'grok', name: 'Grok', engine: 'Grok CLI', mode: 'subscription',
    authType: 'official', defaultModel: '', models: [], baseUrl: '', accent: '#d4d8d5',
    description: 'Sign in with your Grok account through the included official Grok client.',
    billingNote: 'Your eligible Grok account plan and limits apply. This connection uses account sign-in and never falls back to an xAI API key.',
    setupUrl: 'https://docs.x.ai/build/overview',
  },
  {
    id: 'muse-code', name: 'Muse Code', engine: 'Muse Code', mode: 'subscription', aliases: ['Meta', 'Muse Wonder', 'Wonder Full'],
    authType: 'official', defaultModel: '', models: [], baseUrl: '', accent: '#77b5ff',
    description: 'Install Meta’s official Muse Code client separately to use your subscription. Your account’s models and effort settings appear after sign-in.',
    billingNote: 'Your Muse Code plan, including Power, and its limits apply. Wonder and Wonder Full depend on your account’s access. Contributor mode is off for Exomina sessions. No API-key fallback.',
    setupUrl: 'https://dev.meta.ai/lp/muse-code',
  },
  api({
    id: 'openai-api', name: 'OpenAI API',
    baseUrl: 'https://api.openai.com/v1',
    description: 'Connect an OpenAI API key and choose a chat model with tool support.',
    billingNote: 'OpenAI API usage is billed separately from your ChatGPT subscription. Exomina’s safety limits apply.',
    setupUrl: 'https://platform.openai.com/api-keys',
  }),
  api({
    id: 'anthropic-api', name: 'Anthropic API', engine: 'Anthropic Messages API',
    protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1',
    description: 'Connect a Claude Console API key using the Anthropic Messages API.',
    billingNote: 'Claude Console API usage uses separate API billing; this is not the Claude subscription connection. Exomina’s safety limits apply.',
    setupUrl: 'https://platform.claude.com/',
  }),
  api({
    id: 'gemini', name: 'Gemini API',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    description: 'Use a Gemini API key from Google AI Studio. For Google account sign-in, use the Gemini subscription connection.',
    billingNote: 'Your Gemini API project’s free or paid tier applies. A Google AI app subscription does not establish this connection’s API quota.',
    setupUrl: 'https://aistudio.google.com/apikey',
  }),
  api({
    id: 'xai', name: 'Grok API',
    baseUrl: 'https://api.x.ai/v1',
    description: 'Connect an xAI API key for available Grok chat models. For account sign-in, use the Grok subscription connection.',
    billingNote: 'Your xAI API account’s usage and billing apply; this connection does not sign in to an X or Grok app subscription.',
    setupUrl: 'https://console.x.ai/',
  }),
  api({
    id: 'custom-api', name: 'Your own AI', optional: true,
    configurableEndpoint: true, optionalKey: true, baseUrl: '',
    aliases: ['local', 'hosted', 'LM Studio', 'Ollama', 'OpenRouter', 'OpenAI compatible', 'custom'],
    description: 'Connect a local model server or a hosted service that supports the OpenAI Chat Completions API.',
    billingNote: 'Local servers use your computer’s resources. Hosted services have their own quotas, billing and privacy rules. Prompts and approved tool results go to the address you choose. No automatic fallback.',
  }),
].map((entry) => Object.freeze({
  ...entry,
  models: Object.freeze(entry.models || []),
})));

export function getProvider(id) {
  return PROVIDER_CATALOG.find((provider) => provider.id === id);
}

/** Connections that stay off until the user explicitly turns them on. */
export function isOptInProvider(id) {
  return getProvider(id)?.optIn === true;
}

export function isNativeProvider(id) {
  return getProvider(id)?.mode === 'subscription';
}
