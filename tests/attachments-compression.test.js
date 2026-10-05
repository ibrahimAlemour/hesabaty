// يثبّت ضغط صور المرفقات قبل الرفع (attachments.js: compressImageIfNeeded): صورة كبيرة تُضغط وتُحوَّل
// لـjpeg بأبعاد محدودة، بينما الملفات الصغيرة وPDF تمر دون أي تغيير
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    const result = await page.evaluate(async () => {
      const { compressImageIfNeeded } = await import('./js/attachments.js');

      const canvas = document.createElement('canvas');
      canvas.width = 3000; canvas.height = 2000;
      const ctx = canvas.getContext('2d');
      const imgData = ctx.createImageData(3000, 2000);
      for (let i = 0; i < imgData.data.length; i++) imgData.data[i] = Math.floor(Math.random() * 256);
      ctx.putImageData(imgData, 0, 0);
      const bigBlob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const bigFile = new File([bigBlob], 'فاتورة.png', { type: 'image/png' });
      const compressed = await compressImageIfNeeded(bigFile);
      const bitmap = await createImageBitmap(compressed);

      const smallCanvas = document.createElement('canvas');
      smallCanvas.width = 50; smallCanvas.height = 50;
      smallCanvas.getContext('2d').fillRect(0, 0, 50, 50);
      const smallBlob = await new Promise((r) => smallCanvas.toBlob(r, 'image/png'));
      const smallFile = new File([smallBlob], 'صغير.png', { type: 'image/png' });

      const pdfFile = new File([new Uint8Array([1, 2, 3])], 'ملف.pdf', { type: 'application/pdf' });

      return {
        originalSize: bigFile.size,
        compressedSize: compressed.size,
        compressedType: compressed.type,
        maxDim: Math.max(bitmap.width, bitmap.height),
        smallUnchanged: (await compressImageIfNeeded(smallFile)) === smallFile,
        pdfUnchanged: (await compressImageIfNeeded(pdfFile)) === pdfFile
      };
    });

    assert('الصورة المضغوطة أصغر بكثير من الأصل', result.compressedSize < result.originalSize * 0.5);
    assert('الصورة المضغوطة بصيغة jpeg', result.compressedType === 'image/jpeg');
    assert('أكبر بُعد للصورة المضغوطة لا يتجاوز 1600px', result.maxDim <= 1600);
    assert('ملف صغير أصلًا (<300KB) يُعاد بدون أي تغيير', result.smallUnchanged);
    assert('ملف PDF يُعاد بدون أي معالجة', result.pdfUnchanged);
  });
  summary();
})();
