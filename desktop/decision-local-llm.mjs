// Tier 3 backend: a small chat model behind a local OpenAI-compatible server
// (Ollama, LM Studio). Nothing is downloaded or started here; the backend is only
// used when the user already runs such a server on this PC.
export const LOCAL_SERVERS = [
  {name: 'Ollama', url: 'http://127.0.0.1:11434/v1'},
  {name: 'LM Studio', url: 'http://127.0.0.1:1234/v1'}
];

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

async function getJson(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {...init, signal: controller.signal});
    if (!response.ok) throw Error(`Local model server answered ${response.status}.`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

/** Finds a running local server with at least one model. Returns null when none answers. */
export async function findLocalServer({fetchImpl = fetch, servers = LOCAL_SERVERS, preferredModel = ''} = {}) {
  for (const server of servers) {
    try {
      const data = await getJson(fetchImpl, server.url + '/models', {}, 1500);
      const models = (data?.data || []).map(model => model?.id).filter(Boolean)
        .filter(id => !/embed/i.test(id));
      if (!models.length) continue;
      return {...server, model: models.includes(preferredModel) ? preferredModel : models[0], models};
    } catch {}
  }
  return null;
}

/**
 * Asks the model to answer with a single option letter and reads the probability of
 * each letter from the token logprobs. When the server gives no logprobs the answer
 * is still used, but marked uncalibrated so the router treats it cautiously.
 */
export async function askLocalModel(server, {question, input, options}, {fetchImpl = fetch, timeoutMs = 20000} = {}) {
  const letters = options.map((_, index) => LETTERS[index]);
  const prompt = [
    question.trim(),
    input ? `\nInput:\n${String(input).slice(0, 6000)}` : '',
    '\nOptions:',
    ...options.map((option, index) => `${letters[index]}. ${option}`),
    `\nAnswer with exactly one letter (${letters.join(', ')}) and nothing else.`
  ].join('\n');
  const data = await getJson(fetchImpl, server.url + '/chat/completions', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      model: server.model,
      messages: [{role: 'system', content: 'You are a precise classifier. Reply with one option letter only.'}, {role: 'user', content: prompt}],
      max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: 20
    })
  }, timeoutMs);

  const choice = data?.choices?.[0];
  const top = choice?.logprobs?.content?.[0]?.top_logprobs || [];
  const mass = letters.map(letter => top
    .filter(entry => String(entry.token).trim().replace(/[.)]/g, '').toUpperCase() === letter)
    .reduce((sum, entry) => sum + Math.exp(entry.logprob), 0));
  // Only trust the probabilities when the model put nearly all its probability on the
  // option letters; renormalising a small remainder would invent confidence. Even then
  // these are the model's own probabilities, not validated calibration.
  const total = mass.reduce((a, b) => a + b, 0);
  if (total >= 0.9) return {probabilities: mass.map(value => value / total), calibrated: true};
  if (total > 0) return {probabilities: mass.map(value => value / total), calibrated: false};

  const text = String(choice?.message?.content || '').trim().toUpperCase();
  const picked = letters.indexOf(text[0]);
  if (picked < 0) throw Error('The local model did not answer with an option.');
  return {probabilities: options.map((_, index) => (index === picked ? 1 : 0)), calibrated: false};
}

/**
 * Asks Ollama to unload the model now (keep_alive 0) instead of after its 5-minute idle
 * timeout. LM Studio has no equivalent request; it keeps its own idle timeout.
 */
export async function releaseLocalModel(server, {fetchImpl = fetch} = {}) {
  if (server?.name !== 'Ollama') return false;
  await getJson(fetchImpl, server.url.replace(/\/v1$/, '') + '/api/generate', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({model: server.model, keep_alive: 0})
  }, 3000);
  return true;
}
