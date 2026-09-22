// معالج الإعداد الأولي (Setup Wizard)
import { updateSettings, ensureDefaultCategories, addProduct } from './database.js';
import { createOwnerAccount } from './auth.js';
import { loadSeedData } from './seed.js';
import { toastError, toastSuccess, setLoading } from './ui.js';
import { escapeHtml } from './utils.js';

const SUGGESTED_PRODUCTS = [
  { name: 'لحم بلدي', category_name: 'لحوم', unit: 'كغ', cost_price: 35, selling_price: 45 },
  { name: 'دجاج', category_name: 'دجاج', unit: 'كغ', cost_price: 14, selling_price: 18 },
  { name: 'بندورة', category_name: 'خضار', unit: 'كغ', cost_price: 2.5, selling_price: 4 },
  { name: 'خيار', category_name: 'خضار', unit: 'كغ', cost_price: 2, selling_price: 3.5 },
  { name: 'بطاطا', category_name: 'خضار', unit: 'كغ', cost_price: 2, selling_price: 3 },
  { name: 'تفاح', category_name: 'فواكه', unit: 'كغ', cost_price: 5, selling_price: 8 }
];

let state = { shopName: '', selectedProducts: new Set(SUGGESTED_PRODUCTS.map(p => p.name)), demoData: true };
let step = 1;

export function renderSetupWizard(container) {
  container.style.display = '';
  renderStep(container);
}

function renderStep(container) {
  container.innerHTML = `
    <div class="setup-wizard">
      <div class="wizard-progress">
        ${[1,2,3,4].map(i => `<div class="dot ${i <= step ? 'active' : ''}"></div>`).join('')}
      </div>
      <div class="wizard-step">${stepContent()}</div>
    </div>`;
  bindStep(container);
}

function stepContent() {
  if (step === 1) return `
    <h2>مرحبًا بك في حساباتي 👋</h2>
    <p class="desc">لنبدأ بإعداد محلك. ما اسم المحل؟</p>
    <div class="form-group">
      <label>اسم المحل</label>
      <input type="text" id="w-shop-name" placeholder="مثال: ملحمة أبو محمد" value="${escapeHtml(state.shopName)}">
    </div>
    <button class="btn btn-primary btn-block" id="w-next">التالي</button>`;

  if (step === 2) return `
    <h2>العملة</h2>
    <p class="desc">سيتم استخدام العملة التالية في كل الفواتير والتقارير.</p>
    <div class="card" style="text-align:center;padding:26px;">
      <div style="font-size:40px;font-weight:800;color:var(--primary);">₪</div>
      <div style="color:var(--text-muted);margin-top:6px;">الشيكل الإسرائيلي</div>
    </div>
    <button class="btn btn-primary btn-block" id="w-next">التالي</button>
    <button class="btn btn-secondary btn-block" style="margin-top:8px;" id="w-back">رجوع</button>`;

  if (step === 3) return `
    <h2>منتجاتك الأولية</h2>
    <p class="desc">اختر المنتجات لإضافتها الآن، يمكنك تعديلها لاحقًا من صفحة المنتجات.</p>
    <div class="swatch-row">
      ${SUGGESTED_PRODUCTS.map(p => `<span class="swatch ${state.selectedProducts.has(p.name) ? 'active' : ''}" data-name="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>`).join('')}
    </div>
    <div class="divider-label"></div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;margin-bottom:16px;">
      <input type="checkbox" id="w-demo" ${state.demoData ? 'checked' : ''}> تحميل بيانات تجريبية (فواتير وزبائن وهمية) للتجربة السريعة
    </label>
    <button class="btn btn-primary btn-block" id="w-next">التالي</button>
    <button class="btn btn-secondary btn-block" style="margin-top:8px;" id="w-back">رجوع</button>`;

  return `
    <h2>حساب صاحب المحل</h2>
    <p class="desc">أنشئ حسابك لتسجيل الدخول إلى التطبيق.</p>
    <div class="form-group"><label>الاسم</label><input type="text" id="w-owner-name" placeholder="اسمك"></div>
    <div class="form-group"><label>البريد الإلكتروني (اختياري)</label><input type="text" id="w-owner-email" placeholder="example@mail.com"></div>
    <div class="form-group"><label>كلمة المرور</label><input type="password" id="w-owner-pass" placeholder="6 أحرف على الأقل"></div>
    <button class="btn btn-primary btn-block" id="w-finish">إنشاء الحساب والبدء</button>
    <button class="btn btn-secondary btn-block" style="margin-top:8px;" id="w-back">رجوع</button>`;
}

function bindStep(container) {
  const next = container.querySelector('#w-next');
  const back = container.querySelector('#w-back');
  const finish = container.querySelector('#w-finish');

  if (next) next.onclick = () => {
    if (step === 1) {
      const name = container.querySelector('#w-shop-name').value.trim();
      if (!name) return toastError('أدخل اسم المحل');
      state.shopName = name;
    }
    if (step === 3) {
      state.demoData = container.querySelector('#w-demo').checked;
    }
    step++;
    renderStep(container);
  };
  if (back) back.onclick = () => { step--; renderStep(container); };

  container.querySelectorAll('.swatch').forEach(el => {
    el.onclick = () => {
      const name = el.dataset.name;
      if (state.selectedProducts.has(name)) state.selectedProducts.delete(name); else state.selectedProducts.add(name);
      el.classList.toggle('active');
    };
  });

  if (finish) finish.onclick = async () => {
    const name = container.querySelector('#w-owner-name').value.trim();
    const email = container.querySelector('#w-owner-email').value.trim();
    const pass = container.querySelector('#w-owner-pass').value;
    if (!name) return toastError('أدخل الاسم');
    if (pass.length < 6) return toastError('كلمة المرور يجب أن تكون 6 أحرف على الأقل');
    setLoading(finish, true, 'جاري الإنشاء...');
    try {
      await updateSettings({ shopName: state.shopName, currency: '₪' });
      const categories = await ensureDefaultCategories();
      const catIdByName = new Map(categories.map(c => [c.name, c.id]));
      for (const p of SUGGESTED_PRODUCTS) {
        if (state.selectedProducts.has(p.name)) {
          const { category_name, ...rest } = p;
          await addProduct({ ...rest, category_id: catIdByName.get(category_name), quick_access: true });
        }
      }
      await createOwnerAccount({ name, email, password: pass });
      if (state.demoData) await loadSeedData();
      await updateSettings({ setupCompleted: true });
      toastSuccess('تم إعداد التطبيق بنجاح');
      window.location.hash = '#/dashboard';
      window.location.reload();
    } catch (err) {
      console.error(err);
      toastError('حدث خطأ أثناء الإعداد. حاول مرة أخرى.');
      setLoading(finish, false);
    }
  };
}
