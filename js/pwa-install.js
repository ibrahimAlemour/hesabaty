// يدير زر "تثبيت التطبيق" المخصص، بدل الاعتماد فقط على إشعار المتصفح التلقائي (غير مضمون الظهور دائمًا)
// يُستورد مرة واحدة من نقطة الدخول (app.js / admin-app.js) حتى يلتقط حدث beforeinstallprompt من أول لحظة تحميل
import { openSheet, closeSheet } from './ui.js';

let deferredPrompt = null;
const listeners = new Set();

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  listeners.forEach(fn => fn());
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  listeners.forEach(fn => fn());
});

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

export function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function canPromptInstall() {
  return !!deferredPrompt;
}

export async function promptInstall() {
  if (!deferredPrompt) return null;
  deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice;
  deferredPrompt = null;
  return choice;
}

// يربط زرًا موجودًا بمنطق التثبيت: يُخفيه إن كان التطبيق مثبّتًا أصلاً، ويعرض تعليمات يدوية على آيفون
// (متصفح Safari لا يدعم إشعار beforeinstallprompt، فلازم المستخدم يضيفه يدويًا من زر المشاركة)
export function wireInstallButton(btn, { onIOSInstructions } = {}) {
  if (!btn) return;
  if (isStandalone()) { btn.style.display = 'none'; return; }

  const ios = isIOS();
  const refresh = () => { btn.style.display = (ios || canPromptInstall()) ? '' : 'none'; };
  refresh();
  listeners.add(refresh);

  btn.onclick = async () => {
    if (ios) { if (onIOSInstructions) onIOSInstructions(); return; }
    if (!canPromptInstall()) return;
    await promptInstall();
    refresh();
  };
}

// تعليمات يدوية للتثبيت على آيفون (Safari) حيث لا يوجد حدث beforeinstallprompt
export function showIOSInstallInstructions() {
  openSheet(`
    <div class="sheet-header"><h3>📲 تثبيت التطبيق على آيفون</h3></div>
    <p style="line-height:2;font-size:14.5px;">
      1. اضغط زر <b>المشاركة</b> (المربع وفيه سهم للأعلى) بشريط Safari بالأسفل.<br>
      2. مرّر لتحت واختر <b>"إضافة إلى الشاشة الرئيسية"</b>.<br>
      3. اضغط <b>إضافة</b> أعلى الشاشة.
    </p>
    <button class="btn btn-primary btn-block" data-act="confirm">تمام، فهمت</button>
  `, { onOpen: (el) => el.querySelector('[data-act="confirm"]').onclick = closeSheet });
}
