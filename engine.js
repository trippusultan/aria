'use strict';
// Aria engine: extraction, identity resolution, assistant. Node stdlib only.
// LLM mode when ANTHROPIC_API_KEY is set; deterministic rules otherwise (and on any model failure).

const API = 'https://api.anthropic.com/v1/messages';
const model = () => process.env.ARIA_MODEL || 'claude-opus-5-5';

async function callClaude(body) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: model(), max_tokens: 4096, ...body }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---------- Jev (TypeSafe): typed decisions, no prose ----------
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
function jevKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try { // jev-cli config: providers:\n  jev:\n    apiKey: <key>
    const y = fs.readFileSync(nodePath.join(os.homedir(), '.jev-cli', 'config.yaml'), 'utf8');
    const m = /^\s*jev:\s*\r?\n((?:[ \t]+.*\r?\n?)*)/m.exec(y.slice(y.search(/^providers:/m) + 1));
    // YAML scalar: "double" (may fold across lines with a trailing backslash), 'single', or plain
    const k = m && /^\s*apiKey:\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'([^']*)'|([^\s#]+))/m.exec(m[1]);
    if (!k) return null;
    const v = k[1] != null ? k[1].replace(/\\\r?\n\s*/g, '').replace(/\s*\r?\n\s*/g, ' ') : (k[2] ?? k[3]);
    return v.trim() || null;
  } catch { return null; }
}
const hasJev = () => !!jevKey();
async function jev(state, questions) {
  const key = jevKey();
  if (!key) throw new Error('jev: no key');
  const wire = Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { ...q, type: q.type === 'boolean' ? 'noul' : q.type }]));
  const once = async () => {
    const r = await fetch(JEV_URL, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ state, model: process.env.ARIA_JEV_MODEL || 'jev-latest', questions: wire }), signal: AbortSignal.timeout(4000) });
    const text = await r.text();
    if (!r.ok) throw Object.assign(new Error(`jev ${r.status}`), { retry: r.status >= 500 || /probabilit/i.test(text) });
    const j = JSON.parse(text);
    if (!j || typeof j.answers !== 'object') throw new Error('jev: no answers');
    return Object.fromEntries(Object.entries(j.answers).map(([id, a]) => [id, a && a.type === 'noul' ? { type: 'boolean', probability: a.noul } : a]));
  };
  try { return await once(); } catch (e) { if (e.retry) return once(); throw e; }
}

// ---------- dates ----------
const DAYS = ['sun', 'mon', 'tues', 'wednes', 'thurs', 'fri', 'satur'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const PRE = String.raw`(?:(?:by|before|on|until|till|no later than|this|next)\s+)?`;
const ymd = d => d.toISOString().slice(0, 10);
const plus = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };

// Local calendar day (YYYY-MM-DD) of an instant in an IANA zone; missing or bad tz -> UTC.
function localDay(iso, tz) {
  const d = new Date(iso || Date.now());
  if (isNaN(d)) return null;
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); } catch { return ymd(d); }
}

function parseDue(text, baseISO, tz) {
  const day = localDay(baseISO, tz);
  if (!day) return null;
  const base = new Date(`${day}T00:00:00Z`); // the local day, carried as UTC midnight for weekday math
  const dow = base.getUTCDay();
  const rules = [
    [/(\d{4})-(\d{2})-(\d{2})\b/, m => new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)],
    [/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?![a-z])/i, m => monthDay(+m[1], m[2])],
    [/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i, m => monthDay(+m[2], m[1])],
    [/\btomorrow\b/i, () => plus(base, 1)],
    [/\b(?:today|tonight|end of (?:the )?day|eod)\b/i, () => base],
    [/\b(?:end of (?:the |this )?week|eow)\b/i, () => plus(base, (5 - dow + 7) % 7)],
    [/\b(mon|tues|wednes|thurs|fri|satur|sun)day\b/i, m => plus(base, (DAYS.indexOf(m[1].toLowerCase()) - dow + 7) % 7 || 7)],
  ];
  function monthDay(day, mon) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), MONTHS.indexOf(mon.toLowerCase().slice(0, 3)), day));
    if (d < base) d.setUTCFullYear(d.getUTCFullYear() + 1);
    return d;
  }
  for (const [re, fn] of rules) {
    const m = text.match(new RegExp(PRE + re.source, re.flags));
    if (!m) continue;
    const inner = m[0].match(re);
    const d = fn(inner);
    if (!isNaN(d)) return { date: ymd(d), span: m[0] };
  }
  return null;
}

// ---------- identity ----------
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = s => new RegExp(`(?:^|\\W)${esc(s)}(?:$|\\W)`, 'i'); // whole-word match that also works for names starting with symbols
const low = s => String(s || '').trim().toLowerCase();
const first = s => low(s).split(/\s+/)[0];

function resolveStakeholder(name, participants = []) {
  const n = String(name || '').trim(), l = low(n);
  const hit = participants.find(p => (p.email && low(p.email) === l) || (p.name && low(p.name) === l));
  if (hit) return { name: hit.name || hit.email, email: hit.email || null, unverified: false };
  if (l && !l.includes(' ')) {
    const byFirst = participants.filter(p => p.name && first(p.name) === l);
    if (byFirst.length === 1) return { name: byFirst[0].name, email: byFirst[0].email || null, unverified: false };
  }
  return { name: n, email: null, unverified: true };
}

// ---------- rules extraction ----------
const VERBS = new Set(('send share turn draft prepare review check confirm follow get chase attach update schedule set call email write ' +
  'circulate loop look close fix file submit book finalize finalise sign provide forward raise ask reach put pull run deliver arrange ' +
  'organise organize prep complete finish revert respond reply sort handle add create compile collect reconcile introduce connect ' +
  'escalate approve present walk dig find flag verify validate pass hand mail ping sync').split(' '));
const COMMIT = /\b(?:I['’]ll|I will|I can|I['’]m going to|I am going to|let me)\s+(?:also\s+|just\s+|quickly\s+|then\s+|definitely\s+)?([a-z]+)\b(.*)$/i;
const REQUEST = /\b(?:can you|could you|would you|will you|please)\s+(?:also\s+|just\s+|quickly\s+|kindly\s+|please\s+)?([a-z]+)\b(.*)$/i;
const FOLLOW = /\blet['’]?s\s+(reconvene|regroup|meet|catch up|sync|reconnect|follow up|circle back|talk|touch base)\b(.*)$/i;
const VOC = /(?:^|[,.;]\s*)([A-Z][a-z]+),\s*(?:can|could|would|will|please)\b/;
const HYPO = /\b(?:could consider|might|maybe|perhaps|what if|if we|would be nice|in theory|hypothetically)\b/i;
const NOISE = /\b(?:unsubscribe|click here|read more|view in browser|manage preferences|status update)\b/i;
const PRONOUN = /\b(?:it|this|that|them|these|those)\b/i;

function cleanTitle(clause, span) {
  let t = span ? clause.replace(span, ' ') : clause;
  t = t.replace(/[,;:]?\s*\b(?:so that|so|because|since|but|and come back|and get back|and revert)\b.*$/i, '')
    .replace(/\b(?:we discussed|we talked about|on my side|for it|to you|back to you|as well|too|also|please|asap)\b/gi, ' ')
    .replace(/\bturn (.+?) around\b/i, 'send revised $1')
    .replace(/\b(send|pass|hand) over\b/i, '$1')
    .replace(/\bthe\s+/gi, '')
    .replace(/[?.!,;:\s]+$/, '').replace(/\s+/g, ' ').trim();
  t = t.split(' ').slice(0, 10).join(' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function units(input, isUserName) {
  const text = input.text || '';
  const lines = [...text.matchAll(/^\[[\d:]+\]\s*([^:\n]+?):[ \t]*(.*)$/gm)];
  if (lines.length) return lines.map(m => ({ speaker: m[1].trim(), text: m[2], offset: m.index + m[0].length - m[2].length, isUser: isUserName(m[1]) }));
  const from = (input.participants || []).find(p => p.role === 'from');
  if (input.type === 'email' && from) return [{ speaker: from.name || from.email, text, offset: 0, isUser: isUserName(from.name, from.email) }];
  return [{ speaker: null, text, offset: 0, isUser: true }]; // manual paste: the user's own notes
}

function sentences(u) {
  const out = [], re = /[^.!?\n]+[.!?]*/g;
  let m;
  while ((m = re.exec(u.text))) { const s = m[0].trim(); if (s) out.push({ text: s, offset: u.offset + m.index + m[0].indexOf(s) }); }
  return out;
}

function classify(t, startedAt, tz) {
  if (NOISE.test(t) || HYPO.test(t)) return null;
  const due = parseDue(t, startedAt, tz);
  const voc = (t.match(VOC) || [])[1] || null;
  let m;
  if ((m = t.match(COMMIT)) && VERBS.has(m[1].toLowerCase())) return { kind: 'commit', clause: m[1] + m[2], due, voc };
  if ((m = t.match(REQUEST)) && VERBS.has(m[1].toLowerCase())) return { kind: 'request', clause: m[1] + m[2], due, voc };
  if ((m = t.match(FOLLOW)) && due) return { kind: 'followup', clause: m[1] + m[2], due, voc };
  return null;
}

function rulesExtract(input) {
  if (!input.text) return [];
  const P = input.participants || [];
  const user = input.user || {};
  const isUserName = (name, email) => (email && low(email) === low(user.email)) || (name && low(name) === low(user.name));
  const isUserP = p => isUserName(p.name, p.email);
  const others = P.filter(p => !isUserP(p)).map(p => resolveStakeholder(p.name || p.email, P));
  const userFirst = first(user.name);
  const email = input.type === 'email';
  const recipients = P.filter(p => (p.role === 'to' || p.role === 'cc') && !isUserP(p)).map(p => resolveStakeholder(p.name || p.email, P));
  const userOnlyCc = email && !P.some(p => p.role === 'to' && isUserP(p));
  const person = n => resolveStakeholder(n, P);
  const U = units(input, isUserName);
  const out = [];
  let pending = null; // an ask awaiting the addressee's reply in the next unit

  const add = (s, hit, props) => {
    const title = cleanTitle(hit.clause, hit.due && hit.due.span);
    if (title.split(' ').length < 2) return null; // verb without object: too vague
    const c = { title, due: hit.due, excerpt: s.text, offset: s.offset, speaker: props.speaker ?? null, ...props, _vague: PRONOUN.test(hit.clause) };
    out.push(c);
    return c;
  };
  const merge = (c, s, hit, preferReplyTitle) => {
    const span = input.text.slice(c.offset, s.offset + s.text.length);
    if (span.length <= 400) c.excerpt = span;
    if (!c.due && hit.due) c.due = hit.due;
    const t = cleanTitle(hit.clause, hit.due && hit.due.span);
    if (preferReplyTitle && !PRONOUN.test(hit.clause) && t.split(' ').length >= 2) c.title = t;
    c.confidence = Math.min(0.95, c.confidence + 0.1);
    c.rationale += '; acknowledged in the next turn';
  };

  U.forEach((u, i) => {
    if (pending && pending.i < i - 1) pending = null;
    const next = U[i + 1];
    const speaker = u.speaker ? person(u.speaker) : null;
    for (const s of sentences(u)) {
      const hit = classify(s.text, input.startedAt, input.tz);
      if (!hit) continue;
      const bump = hit.due ? 0.05 : 0;
      if (hit.kind === 'followup') {
        add(s, hit, { owner: 'unclear', direction: 'unclear', stakeholders: others, speaker: u.speaker, confidence: 0.65, rationale: 'Dated follow-up agreed; owner not stated' });
      } else if (u.isUser && hit.kind === 'commit') {
        if (pending && pending.type === 'toUser') { merge(pending.c, s, hit, true); pending = null; continue; }
        const prev = U[i - 1];
        const sh = email ? recipients : prev && !prev.isUser && prev.speaker ? [person(prev.speaker)] : others;
        add(s, hit, { owner: 'user', direction: 'i_owe', stakeholders: sh, speaker: u.speaker, confidence: 0.8 + 2 * bump, rationale: 'User made an explicit first-person commitment' });
      } else if (u.isUser && hit.kind === 'request') {
        let who = hit.voc && low(hit.voc) !== userFirst ? [person(hit.voc)] : null;
        if (!who) who = email ? recipients : others.length === 1 ? others : next && !next.isUser && next.speaker ? [person(next.speaker)] : null;
        if (!who || !who.length) continue;
        const c = add(s, hit, { owner: 'counterpart', direction: 'they_owe', stakeholders: who, speaker: u.speaker, confidence: 0.75 + bump, rationale: 'User asked someone else to do this and expects a return' });
        if (c) {
          if (who.length === 1 && /^(send|share|forward|provide|pass|hand|mail|email)\s/i.test(c.title)) c.title = cleanTitle(`get ${c.title.replace(/^\S+\s/, '')} from ${who[0].name.split(' ')[0]}`);
          pending = { type: 'fromUser', c, who: who.map(w => low(w.name)), i };
        }
      } else if (!u.isUser && hit.kind === 'request') {
        const toUser = hit.voc ? low(hit.voc) === userFirst : email || (next && next.isUser) || others.length === 1;
        if (!toUser || !speaker) continue;
        if (next && next.isUser && /^\s*(?:no\b|nope|i can['’]?t|i cannot|not\b)/i.test(next.text)) continue; // user refused
        const c = add(s, hit, { owner: 'user', direction: 'i_owe', stakeholders: [speaker], speaker: u.speaker, confidence: (userOnlyCc ? 0.6 : 0.75) + bump, rationale: `${speaker.name} asked the user to do this` });
        if (c) pending = { type: 'toUser', c, i };
      } else if (!u.isUser && hit.kind === 'commit' && speaker) {
        if (pending && pending.type === 'fromUser' && pending.who.includes(low(speaker.name))) { merge(pending.c, s, hit, false); pending = null; continue; }
        if (!/\byou(?:r)?\b/i.test(s.text) && !(userFirst && wordRe(userFirst).test(s.text))) continue; // their own work, not owed to the user
        add(s, hit, { owner: 'counterpart', direction: 'they_owe', stakeholders: [speaker], speaker: u.speaker, confidence: 0.7 + bump, rationale: `${speaker.name} committed to something for the user` });
      }
    }
  });
  return out;
}

// ---------- shared post-processing ----------
const STOP = new Set('the a an to of for with and on in my me it this that i is be by'.split(' '));
const toks = s => low(s).replace(/[^a-z0-9#\s]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w));
function similar(a, b) {
  const A = new Set(toks(a)), B = new Set(toks(b));
  if (!A.size || !B.size) return false;
  const inter = [...A].filter(x => B.has(x)).length;
  return inter / new Set([...A, ...B]).size >= 0.8;
}

function finish(cands, input, opts) {
  const floor = opts.floor ?? 0.55;
  const user = input.user || {};
  const P = input.participants || [];
  let list = cands.map(c => ({
    ...c,
    stakeholders: (c.stakeholders || []).filter(s => !(s.email && low(s.email) === low(user.email)) && low(s.name) !== low(user.name)),
  }));
  if (opts.hint) {
    const names = P.filter(p => p.name && low(p.name) !== low(user.name))
      .filter(p => low(p.name).split(/\s+/).some(part => part.length > 1 && wordRe(part).test(opts.hint)))
      .map(p => low(p.name));
    if (names.length) {
      list = list.filter(c => c.stakeholders.some(s => names.includes(low(s.name))))
        .map(c => ({ ...c, confidence: Math.min(0.95, c.confidence + 0.1) }));
    }
  }
  const seen = new Set();
  return list
    .filter(c => c.confidence >= floor)
    .filter(c => !(opts.rejected || []).some(r => similar(r, c.title)))
    .filter(c => { const k = low(c.title); if (seen.has(k)) return false; seen.add(k); return true; })
    .map(({ _vague, ...c }) => ({ ...c, confidence: Math.round(c.confidence * 100) / 100 }));
}

// ---------- LLM extraction ----------
const EXTRACT_SYSTEM = `You extract action items from ONE meeting transcript or email for the user named in the request.
Count only:
- The user committed to do something ("I'll send the revised memo").
- Someone asked the user to do something and the user did not refuse.
- The user asked someone else to do something and expects a return ("Can you confirm with legal?").
- Someone committed to do something for the user.
- A dated follow-up was agreed ("Let's reconvene Friday with numbers").
Ignore: small talk, status narration with no next step, FYI, newsletters/marketing, hypotheticals ("we could consider...") unless accepted, and other people's work that does not involve the user.
Rules:
- Precision over recall. If unsure whether something is an action, leave it out. Never invent.
- excerpt MUST be copied verbatim from the text (exact characters), one to three sentences, max 400 characters.
- direction: i_owe = the user owes the stakeholder; they_owe = the stakeholder owes the user; unclear otherwise.
- owner: user | counterpart | unclear. If you are unsure who owns it, say unclear instead of guessing.
- stakeholders: people involved (use roster names exactly); never include the user.
- due: only if the text states or clearly implies a date. Resolve relative dates against startedAt. span = the exact words that justify it.
- title: short imperative verb phrase (e.g. "Send revised term sheet with prepayment cap").
- confidence 0..1: explicit commitment + object + date ~0.9; request without date ~0.75; vague ~0.6.
Return everything through the record_action_items tool.`;

const EXTRACT_TOOL = {
  name: 'record_action_items',
  description: 'Record the action items found in the source.',
  input_schema: {
    type: 'object',
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['title', 'owner', 'direction', 'stakeholders', 'excerpt', 'confidence', 'rationale'],
          properties: {
            title: { type: 'string' },
            owner: { type: 'string', enum: ['user', 'counterpart', 'unclear'] },
            direction: { type: 'string', enum: ['i_owe', 'they_owe', 'unclear'] },
            stakeholders: { type: 'array', items: { type: 'string' } },
            due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
            due_span: { type: ['string', 'null'] },
            excerpt: { type: 'string' },
            confidence: { type: 'number' },
            rationale: { type: 'string' },
          },
        },
      },
    },
  },
};

// Server-side trust boundary: the model's output is checked against the source before it becomes a candidate.
function validateLLM(items, input) {
  const text = input.text;
  const U = units(input, (n, e) => (e && low(e) === low(input.user?.email)) || low(n) === low(input.user?.name));
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it.excerpt !== 'string' || typeof it.title !== 'string' || !it.title.trim()) continue;
    let excerpt = it.excerpt.trim();
    if (!excerpt || !text.includes(excerpt)) continue; // hallucination guard
    excerpt = excerpt.slice(0, 400);
    const offset = text.indexOf(excerpt);
    const unit = [...U].reverse().find(u => u.offset <= offset);
    if (excerpt.length < 20 && !(unit && unit.text.trim() === excerpt)) continue; // too short to ground anything
    const d = /^\d{4}-\d{2}-\d{2}$/.test(it.due_date || '') ? new Date(`${it.due_date}T00:00:00Z`) : null;
    const realDate = d && !isNaN(d) && ymd(d) === it.due_date; // round-trip rejects 2026-02-31
    const due = realDate && typeof it.due_span === 'string' && it.due_span.trim() && text.includes(it.due_span) ? { date: it.due_date, span: it.due_span } : null;
    out.push({
      title: it.title.trim().slice(0, 120),
      owner: ['user', 'counterpart', 'unclear'].includes(it.owner) ? it.owner : 'unclear',
      direction: ['i_owe', 'they_owe', 'unclear'].includes(it.direction) ? it.direction : 'unclear',
      stakeholders: (Array.isArray(it.stakeholders) ? it.stakeholders : []).filter(s => typeof s === 'string' && s.trim()).map(s => resolveStakeholder(s, input.participants || [])),
      due,
      excerpt,
      offset,
      speaker: unit ? unit.speaker : null,
      confidence: Math.max(0, Math.min(1, Number(it.confidence) || 0)),
      rationale: String(it.rationale || '').slice(0, 200),
    });
  }
  return out;
}

async function extractBase(input, opts = {}) {
  input = input || {};
  if (!input.text) return { mode: 'rules', candidates: [] };
  if (opts.ai && process.env.ANTHROPIC_API_KEY) {
    try {
      const roster = (input.participants || []).map(p => `${p.name || ''} <${p.email || 'no email'}>${p.role ? ` (${p.role})` : ''}`).join('\n');
      const prompt = `User: ${input.user?.name} <${input.user?.email}>\nSource type: ${input.type}\nTitle: ${input.title || ''}\nstartedAt: ${input.startedAt} (local day ${localDay(input.startedAt, input.tz)} in ${input.tz || 'UTC'})\nRoster:\n${roster}\n` +
        (opts.hint ? `The user asks you to focus on: ${opts.hint}\n` : '') +
        (opts.rejected?.length ? `The user previously rejected these as not actions; do not suggest similar: ${opts.rejected.slice(0, 50).join(' | ')}\n` : '') +
        `\n<source>\n${input.text}\n</source>`;
      const res = await callClaude({ system: EXTRACT_SYSTEM, tools: [EXTRACT_TOOL], tool_choice: { type: 'tool', name: EXTRACT_TOOL.name }, messages: [{ role: 'user', content: prompt }] });
      const block = (res.content || []).find(b => b.type === 'tool_use');
      if (!block) throw new Error('no tool_use in response');
      return { mode: 'llm', candidates: finish(validateLLM(block.input?.items, input), input, opts) };
    } catch { /* fall through to rules */ }
  }
  return { mode: 'rules', candidates: finish(rulesExtract(input), input, opts) };
}

async function jevVerify(cands, input) {
  const who = input.user?.name || 'the user';
  const q = {};
  cands.forEach((c, i) => {
    q[`real_${i}`] = { type: 'boolean', instructions: `Is excerpt ${i} a genuine action item involving ${who} (a commitment, a request to or from them, or an agreed dated follow-up), not small talk, a hypothetical, a status update or someone else's own work?` };
    q[`dir_${i}`] = { type: 'choice', instructions: `For excerpt ${i}, who owes the work?`, criteria: { i_owe: `${who} owes it`, they_owe: `Someone else owes it to ${who}`, unclear: 'Not clear' } };
  });
  const state = `${input.type === 'email' ? 'Email' : 'Meeting'} "${String(input.title || '').slice(0, 200)}". The user is ${who}.\n` +
    cands.map((c, i) => `Excerpt ${i}${c.speaker ? ` (${c.speaker})` : ''}: "${String(c.excerpt).slice(0, 400)}"`).join('\n');
  const a = await jev(state, q);
  return cands.flatMap((c, i) => {
    const p = a[`real_${i}`]?.probability;
    if (typeof p !== 'number') return [c];
    if (p < 0.5) return [];
    const d = a[`dir_${i}`];
    const direction = d && (d.probabilities?.[d.choice] ?? 0) >= 0.6 && ['i_owe', 'they_owe', 'unclear'].includes(d.choice) ? d.choice : c.direction;
    const owner = direction === c.direction ? c.owner : direction === 'i_owe' ? 'user' : direction === 'they_owe' ? 'counterpart' : 'unclear';
    return [{ ...c, direction, owner, confidence: Math.round(((c.confidence + p) / 2) * 100) / 100 }];
  });
}

async function extract(input, opts = {}) {
  const out = await extractBase(input || {}, opts);
  if (!(opts.ai && out.candidates.length && hasJev())) return out;
  try {
    const floor = opts.floor ?? 0.55;
    return { mode: `${out.mode}+jev`, candidates: (await jevVerify(out.candidates, input)).filter((c) => c.confidence >= floor) };
  } catch { return out; }
}

// ---------- assistant ----------
const OPEN = ['open', 'in_progress', 'waiting'];
const ALL = ['open', 'in_progress', 'waiting', 'completed', 'cancelled'];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = s => { const d = new Date(`${String(s).slice(0, 10)}T00:00:00Z`); return isNaN(d) ? String(s) : `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`; };
const glyph = t => (!t.source ? 'Manual' : t.source.type === 'meeting' ? 'Zoom' : t.source.type === 'email' ? 'Mail' : 'Manual');
const line = t => `• ${t.title} — ${t.due_at ? `due ${fmtDate(t.due_at)}` : 'no due date'} · ${glyph(t)}${t.source ? ` · ${t.source.title}` : ''} [#${t.id}]`;
const cite = t => ({ task_id: t.id, title: t.title, source_title: t.source ? t.source.title : null });
const reply = (text, tasks = [], proposals = []) => ({ reply: text, citations: tasks.map(cite), proposals });
const uuid = () => globalThis.crypto.randomUUID();
const STATUS_LABEL = { open: 'open', in_progress: 'in progress', waiting: 'waiting', completed: 'completed', cancelled: 'cancelled' };

// Private-data nouns only: "Ananya's meeting" / "yesterday's call" are the user's own sources and stay allowed.
const TIME_WORDS = /^(?:today|yesterday|tomorrow|tonight|week|month|year|quarter|(?:mon|tues|wednes|thurs|fri|satur|sun)day)$/i;
const PRIVATE_REFUSAL = "I can't look into other people's inboxes, transcripts or calls. I only see your own tasks and the sources you connected. I can show what's open between you and them in your tasks instead.";
const INVENT_REFUSAL = "I won't create or restate a commitment that isn't in your sources or tasks. If you did agree to something, add it as a task yourself and I'll track it.";
function guard(msg, req) {
  const m = msg.match(/\b([A-Za-z]+)['’]s\s+(?:e-?mails?|inbox(?:es)?|mailbox(?:es)?|mail|transcripts?|recordings?|dms?|direct messages?)\b/i);
  if ((m && !TIME_WORDS.test(m[1]) && low(m[1]) !== first(req.user?.name)) || /\b(?:his|her|their)\s+(?:inbox|e-?mails?|mailbox|transcripts?|recordings?|dms?)\b/i.test(msg)) {
    return reply(PRIVATE_REFUSAL);
  }
  if (/\b(?:say|pretend|claim|backdate)\b.{0,40}\b(?:I|we)\s+(?:promised|committed|agreed)\b/i.test(msg) || /\b(?:make up|invent|fabricate)\b/i.test(msg)) {
    return reply(INVENT_REFUSAL);
  }
  if (/\bjoin\b.*\b(?:meeting|call|zoom)\b/i.test(msg)) return reply("I can't join meetings. I can prep you for one: ask \"prep me for my meeting with <name>\".");
  return null;
}

// Finds the task the phrase refers to by token overlap; returns {task} or {ask: string}.
function matchTask(phrase, tasks) {
  const id = phrase.match(/#(\d+)/);
  if (id) { const t = tasks.find(x => String(x.id) === id[1]); if (t) return { task: t }; }
  const want = toks(phrase).filter(w => !['task', 'item', 'one', 'done', 'complete', 'completed'].includes(w));
  const scored = tasks.map(t => ({ t, s: want.filter(w => toks(t.title).some(x => x === w || (w.length > 4 && x.startsWith(w.slice(0, 5))))).length }))
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  if (!scored.length) return { ask: `I couldn't find a task matching "${phrase.trim()}". Which task do you mean?` };
  const tied = scored.filter(x => x.s === scored[0].s);
  if (tied.length > 1) return { ask: `Which task do you mean?\n${tied.slice(0, 5).map(x => line(x.t)).join('\n')}`, tasks: tied.slice(0, 5).map(x => x.t) };
  return { task: scored[0].t };
}

async function matchPerson(msg, tools, user, pick) {
  const people = (await tools.listPeople()) || [];
  if (pick?.person) { const p = people.find(x => x.display_name === pick.person); if (p) return { person: p }; } // chosen by Jev
  const l = low(msg);
  const full = people.filter(p => p.display_name && l.includes(low(p.display_name)) && low(p.display_name) !== low(user?.name))
    .sort((a, b) => b.display_name.length - a.display_name.length); // "Ann Lee" beats "Ann"
  if (full.length) return { person: full[0] };
  const byFirst = people.filter(p => p.display_name && first(p.display_name).length > 1 && wordRe(first(p.display_name)).test(msg) && low(p.display_name) !== low(user?.name));
  const names = [...new Set(byFirst.map(p => p.display_name))];
  if (names.length === 1) return { person: byFirst[0] };
  if (names.length > 1) return { ask: `Which person do you mean: ${names.join(', ')}?` };
  return {};
}

function draftFor(t, person, user) {
  const to = (person?.display_name || t.stakeholders?.[0]?.display_name || 'there').split(' ')[0];
  const from = t.source ? ` from ${t.source.title}` : '';
  const body = t.direction === 'they_owe'
    ? `Following up on "${t.title}"${from}. Could you let me know where this stands${t.due_at ? `? It was due ${fmtDate(t.due_at)}.` : '?'}`
    : `Quick update on "${t.title}"${from}: it's in hand${t.due_at ? ` and I'm on track for ${fmtDate(t.due_at)}` : ''}. I'll let you know if anything changes.`;
  return `Hi ${to},\n\n${body}\n\nThanks,\n${(user?.name || '').split(' ')[0]}`;
}

const inBucket = (t, due, now, tz) => {
  if (!t.due_at) return false;
  const today = localDay(now, tz), d = String(t.due_at).slice(0, 10);
  if (due === 'overdue') return d < today;
  if (due === 'today') return d === today;
  return d >= today && d <= ymd(plus(new Date(`${today}T00:00:00Z`), 6)); // today..today+6, matches server
};

async function assistantRules(req) {
  const msg = String(req.message || '').trim();
  const { tools } = req;
  const now = req.now || new Date().toISOString();
  const tz = req.tz;
  const all = async () => (await tools.listTasks({ status: ALL })) || [];

  // --- proposals (never applied here) ---
  let m;
  if ((m = msg.match(/\b(?:add|put|append)\s+(?:a\s+)?note\s+(?:to|on)\s+(.+?)\s*:\s*([\s\S]+)$/i))) {
    const r = matchTask(m[1], await all());
    if (!r.task) return reply(r.ask, r.tasks || []);
    return reply(`Add this note to "${r.task.title}"?\n${line(r.task)}`, [r.task], [{ id: uuid(), action: 'add_note', task_id: r.task.id, args: { body: m[2].trim() }, label: `Add note to '${r.task.title}'` }]);
  }
  if ((m = msg.match(/\bmark\s+(.+?)\s+(?:as\s+)?(complete|completed|done|finished|closed|waiting|in[ -]progress|open|reopened|cancell?ed)\b/i)) || (m = msg.match(/^(?:please\s+)?(?:complete|close|finish)\s+(.+?)()$/i))) {
    const word = low(m[2] || 'completed');
    const status = /^(complete|completed|done|finished|closed)$/.test(word) ? 'completed' : /progress/.test(word) ? 'in_progress' : /cancel/.test(word) ? 'cancelled' : word === 'waiting' ? 'waiting' : 'open';
    const r = matchTask(m[1], await all());
    if (!r.task) return reply(r.ask, r.tasks || []);
    return reply(`Mark this task as ${STATUS_LABEL[status]}? Nothing changes until you confirm.\n${line(r.task)}`, [r.task],
      [{ id: uuid(), action: 'set_status', task_id: r.task.id, args: { status }, label: `Mark '${r.task.title}' as ${STATUS_LABEL[status]}` }]);
  }
  if ((m = msg.match(/^(?:please\s+)?(?:move|push|reschedule|shift|change(?: the due date (?:of|for))?|set(?: the due date (?:of|for))?)\s+(.+?)\s+to\s+(.+?)[.?!]*$/i))) {
    const r = matchTask(m[1], await all());
    if (!r.task) return reply(r.ask, r.tasks || []);
    const none = /^(?:no date|none|no due date|someday)$/i.test(m[2].trim());
    const d = none ? null : parseDue(m[2], now, tz);
    if (!none && !d) return reply(`I couldn't read "${m[2]}" as a date. Try a weekday, "tomorrow", or "1 Oct".`);
    const due_at = d ? d.date : null;
    return reply(`Move "${r.task.title}" to ${due_at ? fmtDate(due_at) : 'no due date'}?\n${line(r.task)}`, [r.task],
      [{ id: uuid(), action: 'set_due', task_id: r.task.id, args: { due_at }, label: `Move '${r.task.title}' to ${due_at ? fmtDate(due_at) : 'no due date'}` }]);
  }
  if ((m = msg.match(/^(?:please\s+)?(?:(?:add|create|new)\s+(?:a\s+)?(?:task|todo|to-do)|remind me)\s*(?:to\b|:)?\s*(.+)$/i))) {
    const d = parseDue(m[1], now, tz);
    let title = cleanTitle(m[1], d && d.span);
    const people = (await tools.listPeople()) || [];
    const stakeholders = people.filter(p => p.display_name && (low(m[1]).includes(low(p.display_name)) || wordRe(first(p.display_name)).test(m[1]))).map(p => p.display_name);
    if (!title) return reply('What should the task say?');
    const args = { title, stakeholders, ...(d ? { due_at: d.date } : {}) };
    return reply(`Create this task?\n• ${title}${d ? ` — due ${fmtDate(d.date)}` : ''}${stakeholders.length ? ` · with ${stakeholders.join(', ')}` : ''}`, [],
      [{ id: uuid(), action: 'create_task', task_id: null, args, label: `Create task '${title}'` }]);
  }

  // --- outbound: deflect to a draft ---
  const sendReq = /^(?:please\s+)?(?:can you\s+|could you\s+)?(?:send|email|mail|forward|reply|message|text)\b/i.test(msg);
  const draftReq = /\b(?:draft|write|compose)\b/i.test(msg);
  if (sendReq || draftReq) {
    const p = await matchPerson(msg, tools, req.user, req.pick);
    if (p.ask) return reply(p.ask);
    const pool = p.person ? ((await tools.listTasks({ status: OPEN, person: p.person.display_name })) || []).filter(t => t.stakeholders?.some(s => s.display_name === p.person.display_name)) : (await tools.listTasks({ status: OPEN })) || [];
    const topic = msg.replace(/^.*?\babout\b/i, '');
    let t = null;
    if (pool.length === 1 && !/\babout\b/i.test(msg)) t = pool[0];
    else if (pool.length) { const r = matchTask(topic, pool); t = r.task || (pool.length === 1 ? pool[0] : null); }
    const pre = sendReq && !draftReq ? "I can't send mail for you; anything outbound goes through you. " : '';
    if (!t && pool.length) {
      return reply(`${pre}Which task should the follow-up be about?\n${pool.map(line).join('\n')}`, pool);
    }
    if (!t) {
      return reply(`${pre}I don't have an open task${p.person ? ` with ${p.person.display_name}` : ''} to ground a follow-up in. Tell me which task, e.g. "draft a follow-up to <name> about <task>".`);
    }
    return reply(`${pre}Here's a draft you can copy:\n\n${draftFor(t, p.person, req.user)}\n\nBased on:\n${line(t)}`, [t]);
  }

  // --- prep ---
  if (/\b(?:prep|prepare|brief)\b.*\bmeeting\b/i.test(msg)) {
    const p = await matchPerson(msg, tools, req.user, req.pick);
    if (p.ask) return reply(p.ask);
    if (!p.person) return reply("Who is the meeting with? I can prep you from your open tasks with that person.");
    const name = p.person.display_name;
    const tasks = ((await tools.listTasks({ status: OPEN, person: name })) || []).filter(t => t.stakeholders?.some(s => s.display_name === name));
    const srcs = [...tasks.map(t => t.source).filter(Boolean), ...((await tools.searchSources(name)) || [])].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    const last = srcs[0] ? `\nLast source: ${srcs[0].title}${srcs[0].started_at ? ` (${fmtDate(srcs[0].started_at)})` : ''}` : '';
    if (!tasks.length) return reply(`I don't have any open tasks with ${name}.${last}`);
    return reply(`Prep for your meeting with ${name}. Open items (${tasks.length}):\n${tasks.map(line).join('\n')}${last}`, tasks);
  }

  // --- "did I promise X" ---
  if ((m = msg.match(/\b(?:did|have)\s+I\s+(?:promise[d]?|commit(?:ted)?|agree[d]?|say I['’]?d|offer(?:ed)?)\b(.*)$/i))) {
    const words = toks(m[1]).filter(w => !['someone', 'anyone', 'anybody', 'somebody', 'last', 'week', 'month', 'yesterday', 'today', 'send', 'to'].includes(w));
    const tasks = await all();
    const hits = tasks.filter(t => words.some(w => low(t.title).includes(w) || low(t.excerpt?.text).includes(w)));
    const srcs = [];
    for (const w of words) for (const s of (await tools.searchSources(w)) || []) if (!srcs.some(x => x.id === s.id)) srcs.push(s);
    if (hits.length) return reply(`These tasks mention ${words.join(' ')}:\n${hits.map(line).join('\n')}`, hits);
    if (srcs.length) return reply(`I checked your ${tasks.length} tasks and found no task about "${words.join(' ')}". These sources mention it, open them to check what was said:\n${srcs.slice(0, 5).map(s => `• ${s.title}${s.started_at ? ` (${fmtDate(s.started_at)})` : ''}`).join('\n')}`);
    return reply(`I checked your ${tasks.length} tasks and searched your sources for "${words.join(' ') || msg}" and found nothing. I have no record of that promise.`);
  }

  // --- "what came out of <meeting>" ---
  if ((m = msg.match(/\b(?:came|come|comes) out of\s+(.+?)[?.!]*$/i)) || (m = msg.match(/\b(?:actions?|action items|tasks?|items?)\s+from\s+(.+?)[?.!]*$/i))) {
    const q = m[1].replace(/^(?:the|my|our)\s+/i, '').replace(/\s+(?:meeting|call|email|thread)$/i, '').trim();
    const tasks = ((await tools.listTasks({ status: ALL, source: q })) || []).filter(t => t.status !== 'cancelled');
    if (tasks.length) return reply(`From ${tasks[0].source?.title || q} (${tasks.length}):\n${tasks.map(line).join('\n')}`, tasks);
    const srcs = (await tools.searchSources(q)) || [];
    if (srcs.length) return reply(`I found ${srcs.map(s => s.title).slice(0, 3).join(', ')} but no confirmed tasks from it. Check the suggestion inbox for pending items.`);
    return reply(`I don't see a meeting or email matching "${q}".`);
  }

  // --- listing queries (composable: status + due + person) ---
  const p = await matchPerson(msg, tools, req.user, req.pick);
  if (p.ask) return reply(p.ask);
  let statuses = null, due = null, closedSince = null, label = 'open';
  if (/\b(?:completed|closed|done|finished)\b|\bclose\b/i.test(msg)) { statuses = ['completed']; label = 'completed'; if (/\b(?:last|this|past) week\b/i.test(msg)) closedSince = plus(new Date(now), -7).toISOString(); }
  else if (/\bwaiting\b|\bowes? me\b/i.test(msg)) { statuses = ['waiting']; label = 'waiting'; }
  else if (/\bin[ -]progress\b/i.test(msg)) { statuses = ['in_progress']; label = 'in-progress'; }
  if (/\b(?:overdue|late|past due)\b/i.test(msg)) { due = 'overdue'; label = 'overdue'; }
  else if (/\btoday\b/i.test(msg)) { due = 'today'; label = 'due-today'; }
  else if (/\bthis week\b|\bdue\b.*\bweek\b/i.test(msg) && !closedSince) { due = 'week'; label = 'due-this-week'; }
  const pendingWords = /\b(?:pending|open|outstanding|on my plate|to-?do|owe|what do i have|tasks?)\b/i.test(msg);
  if (!statuses && !due && !p.person && !pendingWords) {
    return reply('I can list your pending, in-progress, waiting, completed, overdue or due-this-week tasks; show what is open with a person or what came out of a meeting; draft a follow-up; and propose notes, status or due-date changes for you to confirm.');
  }
  const filter = { status: statuses || OPEN };
  if (p.person) filter.person = p.person.display_name;
  if (closedSince) filter.closedSince = closedSince;
  let tasks = (await tools.listTasks(filter)) || [];
  tasks = tasks.filter(t => filter.status.includes(t.status)); // defensive: never show what wasn't asked for
  if (p.person) tasks = tasks.filter(t => t.stakeholders?.some(s => s.display_name === p.person.display_name));
  if (due) tasks = tasks.filter(t => inBucket(t, due, now, tz));
  if (closedSince) tasks = tasks.filter(t => !t.updated_at || t.updated_at >= closedSince.slice(0, 10));
  const who = p.person ? ` with ${p.person.display_name}` : '';
  if (!tasks.length) return reply(`I don't have any ${label.replace(/-/g, ' ')} tasks${who}.`);
  tasks.sort((a, b) => (a.due_at || '9999').localeCompare(b.due_at || '9999'));
  if (!statuses && !due) { // pending: group by due date
    const today = localDay(now, tz);
    const week = ymd(plus(new Date(`${today}T00:00:00Z`), 6));
    const groups = [['Overdue', t => t.due_at && t.due_at < today], ['Due today', t => t.due_at === today], ['Due this week', t => t.due_at && t.due_at > today && t.due_at <= week],
      ['Later', t => t.due_at && t.due_at > week], ['No due date', t => !t.due_at]];
    const body = groups.map(([h, f]) => { const g = tasks.filter(f); return g.length ? `${h}\n${g.map(line).join('\n')}` : ''; }).filter(Boolean).join('\n\n');
    return reply(`You have ${tasks.length} open task${tasks.length > 1 ? 's' : ''}${who}:\n\n${body}`, tasks);
  }
  return reply(`${label.charAt(0).toUpperCase() + label.slice(1).replace(/-/g, ' ')} tasks${who} (${tasks.length}):\n${tasks.map(line).join('\n')}`, tasks);
}

// ---------- LLM assistant ----------
const ASSIST_SYSTEM = `You are Aria's status assistant. You answer ONLY about the user's own tasks, notes and source excerpts, using the tools.
- Every factual line about work must come from a tool result and end with the task id like [#12]. Format task lines as: • <title> — due <date> · <Zoom|Mail|Manual> · <source title> [#id]
- If tools return nothing, say so plainly. Never invent tasks, commitments, people or dates.
- You cannot change anything. To create a task, add a note, change status or due date, call propose_action; the user confirms it in the UI. Say it is awaiting their confirmation.
- Refuse questions about other employees' inboxes, transcripts or calls. Refuse to invent or restate commitments that are not in the sources.
- You cannot send mail or join meetings. Offer a draft the user can copy instead.
- "Prep me for my meeting with X": open items with X plus the latest source.
- Be brief. Plain text.`;

const ASSIST_TOOLS = [
  { name: 'list_tasks', description: "List the user's tasks. Default status is open, in_progress, waiting.", input_schema: { type: 'object', properties: {
    status: { type: 'array', items: { type: 'string', enum: ALL } }, person: { type: 'string' }, q: { type: 'string' },
    due: { type: 'string', enum: ['overdue', 'today', 'week'] }, source: { type: 'string' }, closedSince: { type: 'string' } } } },
  { name: 'get_task', description: 'Get one task by id.', input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } },
  { name: 'search_sources', description: "Search the user's meetings and emails.", input_schema: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } } },
  { name: 'list_people', description: 'List people the user has tasks with.', input_schema: { type: 'object', properties: {} } },
  { name: 'propose_action', description: 'Propose a change for the user to confirm. Does not apply it.', input_schema: { type: 'object', required: ['action', 'args', 'label'], properties: {
    action: { type: 'string', enum: ['set_status', 'add_note', 'set_due', 'create_task'] }, task_id: { type: ['integer', 'null'] },
    args: { type: 'object' }, label: { type: 'string' } } } },
];

async function assistantLLM(req) {
  const { tools } = req;
  const seen = new Map(), proposals = [];
  const note = t => { if (t && t.id != null) seen.set(String(t.id), t); return t; };
  const run = async (name, a = {}) => {
    if (name === 'list_tasks') return ((await tools.listTasks({ status: a.status || OPEN, ...a })) || []).map(note);
    if (name === 'get_task') return note(await tools.getTask(a.id));
    if (name === 'search_sources') return (await tools.searchSources(String(a.q || ''))) || [];
    if (name === 'list_people') return (await tools.listPeople()) || [];
    if (name === 'propose_action') {
      const ok = { set_status: s => ALL.includes(s?.status), add_note: s => typeof s?.body === 'string' && s.body.trim(), set_due: s => s && (s.due_at === null || /^\d{4}-\d{2}-\d{2}$/.test(s.due_at)), create_task: s => typeof s?.title === 'string' && s.title.trim() };
      if (!ok[a.action] || !ok[a.action](a.args)) return { error: 'invalid action or args' };
      if (a.action !== 'create_task' && !seen.has(String(a.task_id))) return { error: 'task_id must come from a tool result' };
      const p = { id: uuid(), action: a.action, task_id: a.action === 'create_task' ? null : a.task_id, args: a.args, label: String(a.label || a.action).slice(0, 140) };
      proposals.push(p);
      return { recorded: true, awaiting_user_confirmation: true };
    }
    return { error: 'unknown tool' };
  };
  const messages = [...(req.history || []).filter(h => h && h.content).slice(-10).map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content) })),
    { role: 'user', content: `Today is ${localDay(req.now, req.tz)} (${req.tz || 'UTC'}). User: ${req.user?.name}.\n\n${req.message}` }];
  while (messages.length && messages[0].role !== 'user') messages.shift();
  for (let round = 0; round <= 5; round++) {
    const res = await callClaude({ system: ASSIST_SYSTEM, tools: ASSIST_TOOLS, messages, ...(round === 5 ? { tool_choice: { type: 'none' } } : {}) });
    const uses = (res.content || []).filter(b => b.type === 'tool_use');
    if (!uses.length) {
      let text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      if (!text) throw new Error('empty reply');
      text = text.replace(/\s*\[#(\d+)\]/g, (s, id) => (seen.has(id) ? s : '')); // drop citations to tasks no tool returned
      const ids = [...new Set([...text.matchAll(/\[#(\d+)\]/g)].map(x => x[1]))];
      return { reply: text, citations: ids.map(id => cite(seen.get(id))), proposals };
    }
    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const u of uses) results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(await run(u.name, u.input)) });
    messages.push({ role: 'user', content: results });
  }
  throw new Error('tool loop exhausted');
}

// ---------- Jev router: Jev decides intent and targets; the rule router renders from real data ----------
const JEV_INTENTS = {
  pending: 'List everything open or pending', in_progress: 'List tasks in progress', waiting: 'List tasks waiting on someone',
  completed: 'List completed tasks', closed_recently: 'What did I close or finish recently or last week',
  open_with_person: 'What is open with a specific person', from_source: 'What came out of a specific meeting or email, named or by date',
  overdue: 'What is overdue', due_week: 'What is due this week', draft_followup: 'Draft or send a follow-up message to someone',
  prep_meeting: 'Prepare me for a meeting with someone', did_i_promise: 'Did I promise, commit or agree to something',
  set_status: 'Mark a task done, waiting, in progress, open or cancelled, or report that a task is done, sent, finished or blocked', add_note: 'Add a note to a task',
  set_due: 'Set or change the due date of a task', create_task: 'Create a new task or reminder',
  refuse_private: "Asks about another person's inbox, emails, transcripts or calls", refuse_invent: 'Asks to invent, fake or backdate a commitment',
  help: 'Greetings, or questions about what the assistant can do; not about a specific task',
};
const STATUS_WORD = { open: 'open', in_progress: 'in progress', waiting: 'waiting', completed: 'completed', cancelled: 'cancelled' };
const idOf = (k) => Number(/^#(\d+)\s/.exec(String(k))?.[1]);
const pick = (a) => (a && typeof a.choice === 'string' ? {
  v: a.choice, p: a.probabilities?.[a.choice] ?? 0,
  top: Object.entries(a.probabilities || {}).filter(([k, p]) => k !== 'none' && p >= 0.15).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k]) => k), // only plausible options
} : null);
const noteBody = (msg) => { const m = msg.match(/:\s*([\s\S]+)$/) || msg.match(/\b(?:saying|that says)\s+["“]?([\s\S]+?)["”]?$/i); return m ? m[1].trim() : null; };

// Returns a canonical command string for assistantRules, a finished reply object, or null (let the rules decide).
async function jevRoute(req) {
  const msg = req.message, now = req.now || new Date().toISOString();
  const tasks = ((await req.tools.listTasks({ status: OPEN })) || []).slice(0, 80);
  const people = ((await req.tools.listPeople()) || []).filter((p) => p.display_name && low(p.display_name) !== low(req.user?.name));
  const sources = ((await req.tools.searchSources('')) || []).slice(0, 40);
  const opts = (list, label) => ({ ...Object.fromEntries(list.map((x) => [label(x), null])), none: 'None of these, or not mentioned' });
  const q = {
    intent: { type: 'choice', instructions: 'What does the user want from their task assistant?', criteria: JEV_INTENTS },
    status: { type: 'choice', instructions: 'Which task status does the user mean, if any?', criteria: { open: 'reopen', in_progress: 'started, working on it', waiting: 'blocked on someone', completed: 'done, finished, sent, closed', cancelled: 'dropped, no longer needed', none: 'no status mentioned' } },
  };
  if (tasks.length) q.task = { type: 'choice', instructions: 'Which existing task is the user referring to?', criteria: opts(tasks, (t) => `#${t.id} ${t.title}`) };
  if (people.length) q.person = { type: 'choice', instructions: 'Which person is the user referring to?', criteria: opts(people, (p) => p.display_name) };
  if (sources.length) q.source = { type: 'choice', instructions: 'Which meeting or email is the user referring to, by name or by date?', criteria: opts(sources, (s) => `#${s.id} ${s.title} (${fmtDate(s.started_at)})`) };
  const today = localDay(now, req.tz);
  const a = await jev(`Today is ${fmtDate(today)} (${today}). The user wrote:\n"""${msg.slice(0, 2000)}"""`, q);

  const it = pick(a.intent);
  if (!it || it.p < 0.5 || !Object.hasOwn(JEV_INTENTS, it.v)) return null;
  const good = (x) => x && x.v !== 'none' && x.p >= 0.5;
  const T = pick(a.task), P = pick(a.person), S = pick(a.source), ST = pick(a.status);
  const task = good(T) ? tasks.find((t) => t.id === idOf(T.v)) || null : null;
  const person = good(P) && people.some((p) => p.display_name === P.v) ? P.v : null;
  const source = good(S) ? sources.find((s) => s.id === idOf(S.v)) || null : null;
  const status = good(ST) && Object.hasOwn(STATUS_WORD, ST.v) ? ST.v : null;
  const whichTask = () => {
    const o = (T?.top || []).map((k) => tasks.find((t) => t.id === idOf(k))).filter(Boolean);
    return o.length ? reply(`Which task do you mean?\n${o.map(line).join('\n')}`, o) : reply("I couldn't find an open task that matches. Which task do you mean? Give me a few words from its title.");
  };
  const whichPerson = () => reply(P?.top?.length ? `Which person do you mean: ${P.top.join(', ')}?` : 'Which person do you mean?');
  const whichSource = () => reply(S?.top?.length ? `Which meeting or email do you mean?\n${S.top.map((k) => `• ${k.replace(/^#\d+\s/, '')}`).join('\n')}` : "I couldn't tell which meeting or email you mean.");
  switch (it.v) {
    case 'pending': return 'what is pending';
    case 'in_progress': return 'what is in progress';
    case 'waiting': return 'what is waiting';
    case 'completed': return 'what have I completed';
    case 'closed_recently': return 'what did I close last week';
    case 'overdue': return 'what is overdue';
    case 'due_week': return 'what is due this week';
    // Names and titles come from outside senders: never paste them into a command the regex router re-reads.
    case 'open_with_person': return person ? { cmd: 'what is open with this person', person } : whichPerson();
    case 'prep_meeting': return person ? { cmd: 'prep me for my meeting', person } : whichPerson();
    case 'from_source': {
      if (!source) return whichSource();
      const got = ((await req.tools.listTasks({ status: ALL })) || []).filter((t) => t.source?.id === source.id && t.status !== 'cancelled');
      const when = source.started_at ? ` (${fmtDate(source.started_at)})` : '';
      return got.length ? reply(`From ${source.title}${when}, ${got.length}:\n${got.map(line).join('\n')}`, got)
        : reply(`I found ${source.title}${when} but no confirmed tasks from it. Check the suggestion inbox for pending items.`);
    }
    case 'draft_followup': {
      const to = person && (!task || task.stakeholders?.some((x) => x.display_name === person)) ? person : null;
      return task ? { cmd: `draft a follow-up about #${task.id}`, person: to } : to ? { cmd: 'draft a follow-up', person: to } : msg;
    }
    case 'set_status':
      if (!task) return whichTask();
      return status ? `mark #${task.id} as ${STATUS_WORD[status]}` : reply(`Which status for "${task.title}": open, in progress, waiting, completed or cancelled?`, [task]);
    case 'add_note': {
      if (!task) return whichTask();
      const body = noteBody(msg);
      return body ? `add a note to #${task.id}: ${body}` : reply(`What should the note on "${task.title}" say?`, [task]);
    }
    case 'set_due': {
      if (!task) return whichTask();
      const d = /\b(?:no date|no due date|someday)\b/i.test(msg) ? { span: 'no date' } : parseDue(msg, now, req.tz);
      return d ? `move #${task.id} to ${d.span}` : reply(`What date should "${task.title}" move to?`, [task]);
    }
    case 'create_task': return /^(?:please\s+)?(?:(?:add|create|new)\s+(?:a\s+)?(?:task|todo|to-do)|remind me)\b/i.test(msg) ? msg : `add a task to ${msg}`;
    case 'did_i_promise': return /\b(?:did|have)\s+I\s+(?:promise|commit|agree|say|offer)/i.test(msg) ? msg : 'did I promise anything';
    case 'refuse_private': return reply(PRIVATE_REFUSAL);
    case 'refuse_invent': return reply(INVENT_REFUSAL);
    default: return 'help';
  }
}

async function assistant(req) {
  req = { ...req, message: String(req?.message || '').trim() };
  const g = guard(req.message, req);
  if (g) return g;
  if (req.ai && hasJev()) {
    try {
      const r = await jevRoute(req);
      if (typeof r === 'string') return { ...(await assistantRules({ ...req, message: r })), router: 'jev' };
      if (r && r.cmd) return { ...(await assistantRules({ ...req, message: r.cmd, pick: { person: r.person } })), router: 'jev' };
      if (r) return { ...r, router: 'jev' };
    } catch { /* Jev down: fall through */ }
  }
  if (req.ai && process.env.ANTHROPIC_API_KEY) {
    try { return await assistantLLM(req); } catch { /* fall back to rules */ }
  }
  return assistantRules(req);
}

module.exports = { extract, resolveStakeholder, assistant, parseDue, jev, jevKey, hasJev };
