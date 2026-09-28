// Renders launch/launch.html to launch/aria-launch.mp4: 1080x1920, 30 fps, 12 s, H.264, silent. Deterministic (seeked per frame).
// Usage: node launch/render-launch.mjs   (needs Playwright + a Chromium, and ffmpeg; see record-demo.mjs for the paths)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const FPS = 30, SECONDS = 12;
const html = new URL('./launch.html', import.meta.url);
const out = fileURLToPath(new URL('./aria-launch.mp4', import.meta.url));

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
await page.goto(html.href);
await page.evaluate(() => window.__ready());
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
for (let f = 0; f < FPS * SECONDS; f++) {
  await page.evaluate((t) => window.__frame(t), f / FPS);
  ff.stdin.write(await page.screenshot({ type: 'png' }));
}
ff.stdin.end();
await new Promise((r) => ff.on('close', r));
await browser.close();
console.log('wrote', out);
