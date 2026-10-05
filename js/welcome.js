// شاشة ترحيب مبسّطة تظهر مرة واحدة فقط لكل جهاز جديد (أول دخول لصاحب المحل)
import { updateSettings } from './database.js';

const STEPS = [
  { icon: '📦', title: 'أضف منتجاتك', desc: 'من "المزيد ← المنتجات" سجّل منتجاتك مع سعر الشراء والبيع' },
  { icon: '🧾', title: 'سجّل أول فاتورة بيع', desc: 'اضغط زر "بيع" بالأسفل، اختر المنتجات وطريقة الدفع' },
  { icon: '👥', title: 'تابع زبائنك وديونهم', desc: 'سجّل بيعًا بالدين لزبون وتابع رصيده من شاشة "الزبائن"' },
  { icon: '📊', title: 'راجع تقاريرك', desc: 'من "التقارير" تابع مبيعاتك وأرباحك اليومية والشهرية' }
];

export async function renderWelcome(container, onDone) {
  container.innerHTML = `
    <div style="text-align:center;padding:26px 16px 10px;">
      <div style="font-size:52px;margin-bottom:8px;">🧾</div>
      <h2 style="margin:0 0 6px;font-size:19px;font-weight:800;color:var(--primary-dark);">مرحبًا بك في حساباتي!</h2>
      <p style="color:var(--text-muted);font-size:14px;margin:0;">خطوات سريعة قبل أن تبدأ:</p>
    </div>
    <div class="card" style="padding:6px 10px;margin-top:14px;">
      ${STEPS.map(stepRow).join('')}
    </div>
    <button class="btn btn-primary btn-block" id="welcome-start-btn" style="margin-top:20px;">ابدأ الاستخدام</button>
  `;

  container.querySelector('#welcome-start-btn').onclick = async () => {
    await updateSettings({ welcomeSeen: true });
    onDone();
  };
}

function stepRow(s) {
  return `
    <div class="list-item">
      <div class="avatar">${s.icon}</div>
      <div class="info">
        <div class="title">${s.title}</div>
        <div class="subtitle">${s.desc}</div>
      </div>
    </div>`;
}
