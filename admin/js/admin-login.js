// شاشة تسجيل دخول لوحة المدير العام
import { adminSignIn } from './admin-auth.js';
import { toastError, setLoading } from '../../js/ui.js';
import { wireInstallButton, showIOSInstallInstructions } from '../../js/pwa-install.js';

export async function renderAdminLogin(container) {
  container.style.display = '';
  container.innerHTML = `
    <div class="setup-wizard" style="justify-content:center;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="font-size:40px;">🛡️</div>
        <h2 style="margin:8px 0 2px;">لوحة المدير العام</h2>
        <p style="color:var(--text-muted);font-size:13.5px;">حساباتي - SaaS</p>
      </div>
      <button class="btn btn-outline btn-block" id="pwa-install-btn" style="display:none;margin-bottom:14px;">📲 تثبيت اللوحة على الجهاز</button>
      <div class="card">
        <div class="form-group"><label>البريد الإلكتروني</label><input type="email" id="a-email" placeholder="admin@example.com"></div>
        <div class="form-group"><label>كلمة المرور</label><input type="password" id="a-pass" placeholder="••••••"></div>
        <button class="btn btn-primary btn-block" id="a-submit">تسجيل الدخول</button>
      </div>
      <p style="text-align:center;font-size:12px;color:var(--text-muted);margin-top:14px;">هذه اللوحة مخصصة لمشغّل النظام فقط</p>
    </div>`;

  container.querySelector('#a-submit').onclick = async () => {
    const btn = container.querySelector('#a-submit');
    const email = container.querySelector('#a-email').value.trim();
    const pass = container.querySelector('#a-pass').value;
    if (!email || !pass) return toastError('أدخل بيانات الدخول');
    setLoading(btn, true, 'جاري الدخول...');
    try {
      await adminSignIn(email, pass);
      window.location.reload();
    } catch (err) {
      toastError(err.message || 'فشل تسجيل الدخول');
      setLoading(btn, false);
    }
  };

  wireInstallButton(container.querySelector('#pwa-install-btn'), { onIOSInstructions: showIOSInstallInstructions });
}
