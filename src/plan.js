'use strict';
// `yay plan` — an LLM synthesizes a clean, high-level SYSTEM PLAN from the specs
// (intent / ensures / feeds / blast-radius across all Cells). It runs at plan-time
// only; the result is cached to .yaylayer/plan.json and baked into the offline map
// as a static, presentation-grade "System Plan" poster. Needs the user's own
// ANTHROPIC_API_KEY (from their .env); no key, no dependency added — just fetch.

function trim(s, n) { return String(s == null ? '' : s).trim().slice(0, n || 200); }

// A compact digest of the specs to feed the model (blast-sorted, capped).
function buildDigest(manifest, project) {
  const cells = manifest.cells || {};
  const byModule = {};
  for (const id of Object.keys(cells)) {
    const c = cells[id];
    if (c.contains && c.contains.length) continue; // skip container Cells
    const m = c.module || 'other';
    (byModule[m] = byModule[m] || []).push({
      cell: id,
      unit: c.unitName || '',
      intent: trim(c.spec && c.spec.intent, 240),
      ensures: trim(c.spec && c.spec.ensures, 160),
      feeds: (c.feeds || []).slice(0, 8),
      blast: c.blast || 0,
      pure: /^yes\b/i.test((c.spec && c.spec.pure) || ''),
    });
  }
  const modules = Object.keys(byModule).map((name) => {
    const list = byModule[name].sort((a, b) => b.blast - a.blast);
    return { name, total: list.length, units: list.slice(0, 40) };
  });
  return { project: project || 'project', modules, moduleFlows: manifest.moduleEdges || [] };
}

const SYSTEM_PROMPT = [
  'You are a systems architect preparing a single conference slide that explains a software system.',
  'You are given a DIGEST of the project\'s formal specs: each unit has an intent (what it does), optional ensures (a postcondition), feeds (data-flow to other Cells), and blast (how many units depend on it — higher = more load-bearing).',
  'Synthesize a clean, high-level SYSTEM PLAN. Group the modules into a few LOGICAL subsystems (not necessarily one per module) that best explain the architecture to a newcomer.',
  'Return ONLY a JSON object, no prose, no code fences, with exactly this shape:',
  '{',
  '  "system": string,            // 2-4 sentence plain-English overview of what the whole system is and does',
  '  "subsystems": [ { "name": string, "modules": [string], "purpose": string, "role": "input"|"data"|"logic"|"output"|"ui"|"other" } ],',
  '  "flows": [ { "from": string, "to": string, "what": string } ],   // subsystem-to-subsystem, "what" is a short data label',
  '  "highlights": [ string ]      // 3-5 short bullets: load-bearing pieces, risks, notable design choices',
  '}',
  'Base everything ONLY on the digest. "from"/"to" in flows must be subsystem names you defined. Keep purposes to one line.',
].join('\n');

function stripToJSON(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

async function callAnthropic(digest, { model, apiKey, maxTokens }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens || 2000, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: 'DIGEST:\n' + JSON.stringify(digest) }] }),
  });
  if (!res.ok) throw new Error('Anthropic API ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 240));
  const data = await res.json();
  return (data && data.content && data.content[0] && data.content[0].text) || '';
}

// OpenAI Chat Completions — also covers OpenAI-COMPATIBLE providers (Groq, Together,
// OpenRouter, Ollama, LM Studio, …) via baseUrl. `tokenField` handles newer OpenAI
// models that require max_completion_tokens instead of max_tokens.
async function callOpenAICompat(digest, { model, apiKey, baseUrl, maxTokens }, tokenField) {
  const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions';
  const body = { model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: 'DIGEST:\n' + JSON.stringify(digest) }] };
  body[tokenField || 'max_tokens'] = maxTokens || 2000;
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = 'Bearer ' + apiKey; // local servers (Ollama/LM Studio) often need no key
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const errText = (await res.text().catch(() => '')).slice(0, 300);
    // some models reject max_tokens and want max_completion_tokens — retry once
    if (res.status === 400 && /max_completion_tokens/.test(errText) && (tokenField || 'max_tokens') === 'max_tokens') {
      return callOpenAICompat(digest, { model, apiKey, baseUrl, maxTokens }, 'max_completion_tokens');
    }
    throw new Error('OpenAI-compatible API ' + res.status + ': ' + errText);
  }
  const data = await res.json();
  return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

// provider: 'anthropic' | 'openai' (openai also = any OpenAI-compatible baseUrl).
async function synthesize(digest, opts) {
  if (typeof fetch !== 'function') throw new Error('global fetch unavailable — needs Node 18+');
  const provider = opts.provider || 'anthropic';
  const model = opts.model || (provider === 'anthropic' ? 'claude-sonnet-5' : 'gpt-4o');
  const text = provider === 'anthropic'
    ? await callAnthropic(digest, { ...opts, model })
    : await callOpenAICompat(digest, { ...opts, model });
  let plan;
  try { plan = stripToJSON(text); } catch (e) { throw new Error('model did not return valid JSON'); }
  plan.system = trim(plan.system, 1200) || 'No overview produced.';
  plan.subsystems = Array.isArray(plan.subsystems) ? plan.subsystems : [];
  plan.flows = Array.isArray(plan.flows) ? plan.flows : [];
  plan.highlights = Array.isArray(plan.highlights) ? plan.highlights : [];
  return plan;
}

module.exports = { buildDigest, synthesize, SYSTEM_PROMPT };
