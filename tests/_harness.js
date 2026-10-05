// أداة مشتركة لكل ملفات الاختبار: تشغّل خادمًا محليًا ثابتًا + متصفح Playwright حقيقي، وتوفّر assert() بسيط
// يطبع النتيجة فورًا بدون إيقاف باقي الاختبارات. كل ملف اختبار يستدعي summary() بالنهاية ليحدّد كود الخروج.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8794;
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/json'
};

function startServer() {
  const server = http.createServer((req, res) => {
    let filePath = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (filePath.endsWith('/')) filePath += 'index.html';
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

// PLAYWRIGHT_CHROMIUM_PATH اختياري: يُستخدم فقط ببيئات لا يتعرّف فيها Playwright تلقائيًا على مسار المتصفح
// (مثل بيئة تطوير هذه الجلسة) - ببيئة طبيعية بعد `npx playwright install chromium` لا حاجة له إطلاقًا
async function withPage(fn) {
  const server = await startServer();
  const launchOpts = process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {};
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`);
    await page.waitForTimeout(300);
    await fn(page, pageErrors);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

let passCount = 0, failCount = 0;
function assert(name, cond) {
  if (cond) { console.log(`  ✅ ${name}`); passCount++; }
  else { console.log(`  ❌ ${name}`); failCount++; }
}

function summary() {
  console.log(`${passCount} ناجح، ${failCount} فاشل`);
  process.exitCode = failCount > 0 ? 1 : 0;
}

module.exports = { withPage, assert, summary };
