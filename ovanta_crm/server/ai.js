import { config } from './config.js';
import { getSecretSetting, getSetting } from './settings.js';
import { bad, HttpError } from './http.js';

export const aiKey = () => config.anthropicApiKey || getSecretSetting('anthropic_api_key');
export const aiModel = () => getSetting('anthropic_model') || config.anthropicModel;
export const aiConfigured = () => !!aiKey();

/** Strip anything executable from model-produced HTML (it is also previewed in a sandboxed iframe). */
export function sanitizeHtml(h) {
  return String(h)
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta|base)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta|base)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*(javascript|data|vbscript):[^"']*\2/gi, '$1="#"')
    .trim();
}

const SYSTEM = `You are a senior B2B email copywriter. You write concise, specific, honest marketing emails that sound human.
Return ONLY a JSON object (no markdown fences, no commentary) with exactly these keys:
- "subject": string, under 60 characters, no ALL CAPS, no spammy phrases or excessive punctuation
- "subject_alternatives": array of 3 other subject lines
- "preheader": string, under 100 characters
- "body_html": string of simple email-safe HTML using only <p>, <h2>, <ul>, <li>, <strong>, <em>, <a>, <br> with inline styles where useful. No <html>/<body> wrapper, no scripts, no images, no unsubscribe footer (the system adds it).
Personalisation: you may use these merge tags exactly as written: {{first_name|there}}, {{company}}, {{title}}. Never invent other tags, and never invent facts, statistics, customers, prices or deadlines that were not in the brief.
If a call-to-action URL is provided, use it in exactly one <a href="URL"> button-style link; otherwise ask the reader to reply to the email instead of inventing a link.`;

function userPrompt(b) {
  const parts = [];
  if (b.task === 'rewrite') parts.push(`Rewrite the existing email below following this instruction: ${b.instruction || 'improve clarity and persuasiveness'}\n\nExisting subject: ${b.current_subject || ''}\nExisting HTML:\n${String(b.current_html || '').slice(0, 8000)}`);
  else parts.push(`Write a marketing email.\nGoal / brief: ${b.brief}`);
  if (b.audience) parts.push(`Audience: ${b.audience}`);
  if (b.tone) parts.push(`Tone: ${b.tone}`);
  if (b.length) parts.push(`Length: ${b.length}`);
  if (b.cta_url) parts.push(`Call-to-action URL: ${b.cta_url}`);
  if (b.sender_name) parts.push(`Sign off as: ${b.sender_name}`);
  return parts.join('\n');
}

/** One Messages API call. Returns the parsed response body; throws friendly HttpErrors. */
export async function callClaude(payload, { timeoutMs = 60000 } = {}) {
  const key = aiKey();
  if (!key) throw bad('AI is not configured. An admin can add an Anthropic API key in Settings → AI assistant.');
  let res;
  try {
    res = await fetch(`${config.anthropicBaseUrl}/v1/messages`, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: aiModel(), ...payload }),
    });
  } catch (e) { throw new HttpError(502, `Could not reach the Claude API (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = data?.error?.message || `status ${res.status}`;
    if (res.status === 401) throw new HttpError(502, 'The Anthropic API key was rejected. Check it in Settings → AI assistant.');
    if (res.status === 429) throw new HttpError(429, 'Claude is rate-limited right now. Try again in a minute.');
    throw new HttpError(502, `Claude API error: ${m}`);
  }
  if (data.stop_reason === 'refusal') throw new HttpError(422, 'Claude declined this request. Try rephrasing it.');
  return data;
}
export const responseText = (data) => (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');

export async function generateEmail(b) {
  const data = await callClaude({ max_tokens: 2500, system: SYSTEM, messages: [{ role: 'user', content: userPrompt(b) }] });
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  let j; try { j = JSON.parse(text.slice(start, end + 1)); } catch { throw new HttpError(502, 'Claude returned a response that could not be read. Please try again.'); }
  if (typeof j.subject !== 'string' || typeof j.body_html !== 'string') throw new HttpError(502, 'Claude returned an incomplete draft. Please try again.');
  return {
    subject: j.subject.replace(/[\r\n]+/g, ' ').slice(0, 200), preheader: String(j.preheader || '').slice(0, 200),
    subject_alternatives: (Array.isArray(j.subject_alternatives) ? j.subject_alternatives : []).map((s) => String(s).slice(0, 200)).slice(0, 5),
    body_html: sanitizeHtml(j.body_html), model: data.model || aiModel(),
  };
}
