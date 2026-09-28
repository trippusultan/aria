// Records a ~30s vertical (1080x1920) demo of the running Aria app. Needs Playwright + ffmpeg.
// Usage: node launch/record-demo.mjs   (server on ARIA_URL, default http://localhost:4180)
// Playwright is not a dependency: `npm i -g playwright` or set PLAYWRIGHT to its path; CHROME overrides the browser.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const BASE = process.env.ARIA_URL || 'http://localhost:4180';
const OUT = new URL('./aria-demo.mp4', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const dir = mkdtempSync(join(tmpdir(), 'aria-vid-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 2, colorScheme: 'dark',
  recordVideo: { dir, size: { width: 1080, height: 1920 } } });
const page = await ctx.newPage();

// Caption / title card overlay, drawn on top of the real app.
const card = (title, sub, full = false) => page.evaluate(([title, sub, full]) => {
  document.getElementById('demo-cap')?.remove();
  if (!title) return;
  const d = document.createElement('div');
  d.id = 'demo-cap';
  d.style.cssText = `position:fixed;z-index:9999;left:0;right:0;${full ? 'top:0;bottom:0;display:grid;place-content:center;gap:14px;background:#0e0e0d;' : 'bottom:118px;display:grid;justify-items:center;gap:6px;'}text-align:center;pointer-events:none;font-family:"Geist Mono",monospace;opacity:0;transition:opacity .35s`;
  const t = document.createElement('div');
  t.textContent = title;
  t.style.cssText = `display:inline-block;margin:0 auto;padding:${full ? '0' : '10px 16px'};background:${full ? 'none' : '#e9e3d6'};color:${full ? '#e9e3d6' : '#0e0e0d'};border-radius:10px;font-size:${full ? 34 : 21}px;font-weight:600;letter-spacing:-.02em;max-width:460px`;
  d.append(t);
  if (sub) { const s = document.createElement('div'); s.textContent = sub; s.style.cssText = `color:${full ? '#a39d90' : '#e9e3d6'};font-size:14px;${full ? '' : 'text-shadow:0 1px 3px #000'}`; d.append(s); }
  document.body.append(d);
  requestAnimationFrame(() => (d.style.opacity = 1));
}, [title, sub, full]);
const api = (method, path, body) => page.evaluate(async ([m, p, b]) => (await fetch(p, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined })).json(), [method, path, body]);

await page.goto(`${BASE}/#/login`);
await page.evaluate(() => { try { localStorage.setItem('aria.theme', 'dark'); } catch {} });
await card('Every call ends in promises.', 'Most of them get lost.', true);
await sleep(2600);

await api('POST', '/api/auth/signup', { email: `demo${Date.now()}@aria-demo.test`, password: 'demo-password-123', name: 'Sam Carter' });
await api('POST', '/api/sample-data', {});
await api('PATCH', '/api/settings', { external_ai: true });
await page.goto(`${BASE}/#/inbox`); await page.reload(); await sleep(900);
await card('Aria reads your calls and mail.', 'Every action item comes with the exact quote.');
await sleep(3000);
await card('You confirm. Nothing happens on its own.');
await page.mouse.move(270, 300); await page.keyboard.press('j'); await sleep(700);
for (let i = 0; i < 3; i++) { await page.keyboard.press('a'); await sleep(1100); }
await sleep(800);

await page.goto(`${BASE}/#/home`); await sleep(900);
await card('Every promise, by person and deadline.', 'T-2d means due in two days.');
await sleep(3200);
await page.mouse.wheel(0, 380); await sleep(1600);

await page.goto(`${BASE}/#/assistant`); await sleep(900);
await card('Ask in plain words.', 'Jev figures out what you mean.');
await page.fill('#chat-input', 'anything still open with Ananya?'); await sleep(900);
await page.keyboard.press('Enter'); await sleep(3200);
await card('Answers only from your own records.');
await sleep(2400);

await card('Aria', 'Every commitment, kept.   @trippusultan', true);
await page.evaluate(() => { // cat logo on the end card
  const t = document.querySelector('#demo-cap div');
  const cat = document.createElement('span'); cat.className = 'logo';
  cat.style.cssText = 'display:block;margin:0 auto 18px;transform:scale(3.2);';
  t.before(cat);
});
await sleep(3000);

await ctx.close(); await browser.close();
const webm = join(dir, readdirSync(dir).find((f) => f.endsWith('.webm')));
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', OUT]);
console.log('wrote', OUT);
