// شاشة تسجيل الدخول
import { getSettings } from './database.js';
import { localSignIn, pinSignIn, supabaseSignIn } from './auth.js';
import { toastError, setLoading, openSheet, closeSheet } from './ui.js';
import { escapeHtml } from './utils.js';

export async function renderLogin(container) {
  container.style.display = '';
  const settings = await getSettings();
  const isSupabase = settings.backendMode === 'supabase';
  const cashiers = (settings.users || []).filter(u => u.role === 'cashier');

  container.innerHTML = `
    <div class="setup-wizard" style="justify-content:center;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="font-size:40px;">🧾</div>
        <h2 style="margin:8px 0 2px;">${escapeHtml(settings.shopName || 'حساباتي')}</h2>
        <p style="color:var(--text-muted);font-size:13.5px;">${isSupabase ? 'تسجيل الدخول (حساب Supabase)' : 'تسجيل الدخول'}</p>
      </div>
      <div class="card">
        <div class="form-group">
          <label>${isSupabase ? 'البريد الإلكتروني' : 'البريد الإلكتروني أو الاسم'}</label>
          <input type="${isSupabase ? 'email' : 'text'}" id="l-id" placeholder="${isSupabase ? 'example@mail.com' : 'أدخل بريدك أو اسمك'}">
        </div>
        <div class="form-group">
          <label>كلمة المرور</label>
          <input type="password" id="l-pass" placeholder="••••••">
        </div>
        <button class="btn btn-primary btn-block" id="l-submit">تسجيل الدخول</button>
      </div>
      ${!isSupabase && cashiers.length ? `
      <div class="divider-label">أو دخول سريع (كاشير)</div>
      <div class="quick-grid">
        ${cashiers.map(c => `<div class="quick-btn" data-cashier="${c.id}"><span class="emoji">👤</span>${escapeHtml(c.name)}</div>`).join('')}
      </div>` : ''}
    </div>`;

  container.querySelector('#l-submit').onclick = async () => {
    const btn = container.querySelector('#l-submit');
    const id = container.querySelector('#l-id').value.trim();
    const pass = container.querySelector('#l-pass').value;
    if (!id || !pass) return toastError('أدخل بيانات الدخول');
    setLoading(btn, true, 'جاري الدخول...');
    try {
      if (isSupabase) await supabaseSignIn(id, pass); else await localSignIn(id, pass);
      window.location.reload();
    } catch (err) {
      toastError(err.message || 'فشل تسجيل الدخول');
      setLoading(btn, false);
    }
  };

  container.querySelectorAll('[data-cashier]').forEach(el => {
    el.onclick = () => {
      const cashierId = el.dataset.cashier;
      const cashier = cashiers.find(c => c.id === cashierId);
      promptPin(cashier);
    };
  });
}

function promptPin(cashier) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>دخول ${escapeHtml(cashier.name)}</h3></div>
    <div class="form-group"><label>رمز الدخول (PIN)</label><input type="password" id="pin-input" inputmode="numeric" placeholder="••••"></div>
    <button class="btn btn-primary btn-block" id="pin-submit">دخول</button>
  `, { onOpen: (el) => el.querySelector('#pin-input').focus() });

  overlay.querySelector('#pin-submit').onclick = async () => {
    const btn = overlay.querySelector('#pin-submit');
    const pin = overlay.querySelector('#pin-input').value;
    if (!pin) return toastError('أدخل الرمز');
    setLoading(btn, true, 'جاري الدخول...');
    try {
      await pinSignIn(cashier.id, pin);
      closeSheet();
      window.location.reload();
    } catch (err) {
      toastError(err.message);
      setLoading(btn, false);
    }
  };
}
