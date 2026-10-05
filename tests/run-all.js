// يشغّل كل ملفات *.test.js بهذا المجلد بالتتابع (كل ملف بعملية Node منفصلة لعزل الحالة بين الاختبارات)
// ويطبع تقريرًا نهائيًا. الخروج بكود غير صفري إن فشل أي ملف - مناسب للاستخدام بـCI مستقبلًا
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

let failed = 0;
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const r = spawnSync(process.execPath, [path.join(dir, file)], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) failed++;
}

console.log(`\n${'-'.repeat(40)}`);
console.log(`${files.length - failed}/${files.length} ملف اختبار نجح بالكامل`);
process.exit(failed > 0 ? 1 : 0);
