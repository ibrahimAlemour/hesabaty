// طبقة قاعدة البيانات الموحّدة (Facade)
// جميع الشاشات تتعامل فقط مع هذا الملف؛ التخزين الفعلي يتم في db-indexeddb.js أو db-supabase.js
// هذا التصميم يسمح بالتبديل بين التخزين المحلي وسوبابيس دون تغيير كود الشاشات
import * as localDb from './db-indexeddb.js';
import * as remoteDb from './db-supabase.js';
import * as sync from './sync.js';
import { uuid, nowISO, toCents, startOfDay, endOfDay } from './utils.js';
import { SAAS_SUPABASE_URL, SAAS_SUPABASE_ANON_KEY } from './saas-config.js';

const SETTINGS_ID = 'app';
let settingsCache = null;

// ---------- الإعدادات ----------
// الافتراضي الآن هو وضع SaaS (سوبابيس): المحلات تُنشأ مركزيًا من لوحة المدير، فجهاز جديد
// يفتح التطبيق لأول مرة يجب أن يرى شاشة تسجيل دخول مباشرة، لا معالج "أنشئ محلك بنفسك" المحلي.
// خيار الإعداد المحلي (بدون إنترنت/بدون SaaS) يبقى متاحًا كبديل اختياري من شاشة الدخول.
const DEFAULT_SETTINGS = {
  id: SETTINGS_ID,
  shopName: 'محلي',
  phone: '',
  address: '',
  currency: '₪',
  timezone: 'Asia/Gaza',
  theme: 'auto',
  backendMode: 'supabase', // local | supabase
  supabaseUrl: SAAS_SUPABASE_URL,
  supabaseAnonKey: SAAS_SUPABASE_ANON_KEY,
  lastInvoiceNumber: 0,
  openingCashBalance: 0, // بالسنت
  openingCashDate: nowISO(),
  setupCompleted: true,
  seedLoaded: false,
  currentUser: null, // { id, name, role }
  users: [], // حسابات محلية: { id, name, email, passwordHash, role }
  currentShopId: null, // معرّف المحل بجدول shops (وضع سوبابيس فقط)
  shopStatus: 'active', // active | suspended (يُحدَّث بعد كل تسجيل دخول عبر سوبابيس)
  updated_at: nowISO()
};

export async function getSettings() {
  if (settingsCache) return settingsCache;
  let s = await localDb.getById('settings', SETTINGS_ID);
  if (!s) {
    s = { ...DEFAULT_SETTINGS };
    await localDb.put('settings', s);
  }
  settingsCache = s;
  window.APP_SETTINGS = s;
  return s;
}

export async function updateSettings(patch) {
  const current = await getSettings();
  const updated = { ...current, ...patch, updated_at: nowISO() };
  await localDb.put('settings', updated);
  settingsCache = updated;
  window.APP_SETTINGS = updated;
  return updated;
}

async function nextInvoiceLabel() {
  const s = await getSettings();
  const n = (s.lastInvoiceNumber || 0) + 1;
  await updateSettings({ lastInvoiceNumber: n });
  return { number: n, label: `INV-${String(n).padStart(6, '0')}` };
}

// طابور بسيط لمنع تعارض ترقيم الفواتير عند نقرات متتالية سريعة
let invoiceMutex = Promise.resolve();
function withInvoiceLock(fn) {
  const run = invoiceMutex.then(fn, fn);
  invoiceMutex = run.catch(() => {});
  return run;
}

// جدول app_settings بسوبابيس أسماء أعمدته snake_case، بينما الإعدادات المحلية كائن JS بأسماء camelCase
// هذا الترابط يحوّل بين الشكلين في الاتجاهين، ويستثني الحقول المحلية البحتة (لا تُشارك بين الأجهزة)
const SETTINGS_REMOTE_FIELDS = {
  shopName: 'shop_name', phone: 'phone', address: 'address', currency: 'currency',
  timezone: 'timezone', theme: 'theme', lastInvoiceNumber: 'last_invoice_number',
  openingCashBalance: 'opening_cash_balance', openingCashDate: 'opening_cash_date'
};

function settingsToRemote(record, shopId) {
  const payload = { id: shopId, shop_id: shopId, updated_at: record.updated_at || nowISO() };
  for (const [local, remote] of Object.entries(SETTINGS_REMOTE_FIELDS)) payload[remote] = record[local];
  return payload;
}

function settingsFromRemote(remoteRow) {
  const patch = {};
  for (const [local, remote] of Object.entries(SETTINGS_REMOTE_FIELDS)) {
    if (remoteRow[remote] !== undefined && remoteRow[remote] !== null) patch[local] = remoteRow[remote];
  }
  return patch;
}

// نحوّل السجل المحلي إلى شكل ملائم لسوبابيس متعدد المحلات: نُرفق shop_id لكل الجداول الأخرى
function toRemotePayload(storeName, record, shopId) {
  if (storeName === 'settings') return settingsToRemote(record, shopId);
  return { ...record, shop_id: shopId };
}

// ---------- كتابة موحّدة (محلي + مزامنة عند تفعيل سوبابيس) ----------
async function writeRecord(storeName, record) {
  await localDb.put(storeName, record);
  const s = await getSettings();
  if (s.backendMode === 'supabase') {
    // قبل أول تسجيل دخول فعلي لا نعرف shop_id بعد؛ لا نحاول الرفع حتى لا يعلق طلب خاطئ بطابور المزامنة للأبد
    if (!s.currentShopId) return record;
    const payload = toRemotePayload(storeName, record, s.currentShopId);
    if (navigator.onLine && remoteDb.getClient()) {
      try { await remoteDb.put(storeName, payload); }
      catch (e) { await sync.enqueue(storeName, 'put', payload); }
    } else {
      await sync.enqueue(storeName, 'put', payload);
    }
  }
  return record;
}

// يسحب كل بيانات المحل من سوبابيس ويحدّث النسخة المحلية (IndexedDB) - يُستدعى بعد تسجيل الدخول وعند بدء التطبيق
// بذلك يمكن رؤية نفس البيانات من أي جهاز جديد يسجّل دخوله بنفس الحساب
const REMOTE_PULL_STORES = ['categories', 'customers', 'products', 'sales', 'saleItems', 'payments', 'expenses', 'cashTransactions', 'auditLog'];
export async function pullFromRemote() {
  const s = await getSettings();
  if (s.backendMode !== 'supabase' || !s.currentShopId || !remoteDb.getClient()) return;

  for (const storeName of REMOTE_PULL_STORES) {
    try {
      const rows = await remoteDb.getAll(storeName);
      if (rows.length) await localDb.bulkPut(storeName, rows);
    } catch (e) {
      console.error(`فشل سحب بيانات ${storeName} من سوبابيس`, e);
    }
  }

  try {
    const remoteSettings = await remoteDb.getById('settings', s.currentShopId);
    if (remoteSettings) await updateSettings(settingsFromRemote(remoteSettings));
  } catch (e) {
    console.error('فشل سحب إعدادات المحل من سوبابيس', e);
  }
}

async function addAudit(entityType, entityId, action, changes) {
  const s = await getSettings();
  const entry = {
    id: uuid(),
    entity_type: entityType,
    entity_id: entityId,
    action,
    changes: JSON.stringify(changes || {}),
    user_id: (s.currentUser && s.currentUser.id) || 'local',
    user_name: (s.currentUser && s.currentUser.name) || 'مستخدم محلي',
    created_at: nowISO()
  };
  await writeRecord('auditLog', entry);
}

export async function getAuditLog(limit = 50) {
  const rows = await localDb.getAll('auditLog');
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}

// ---------- التصنيفات ----------
// كل محل له تصنيفاته الخاصة (معرّفات فريدة عالميًا)، حتى لا تتعارض مع تصنيفات محل آخر بجدول سوبابيس المشترك
const DEFAULT_CATEGORIES = [
  { name: 'لحوم', icon: '🥩' },
  { name: 'دجاج', icon: '🍗' },
  { name: 'خضار', icon: '🥬' },
  { name: 'فواكه', icon: '🍎' },
  { name: 'مواد غذائية', icon: '🧂' },
  { name: 'أخرى', icon: '📦' }
];

export async function ensureDefaultCategories() {
  const existing = await localDb.getAll('categories');
  if (existing.length) return existing;
  const created = [];
  for (const c of DEFAULT_CATEGORIES) {
    const record = { id: uuid(), name: c.name, icon: c.icon, created_at: nowISO() };
    await writeRecord('categories', record);
    created.push(record);
  }
  return created;
}

export async function getCategories() {
  const rows = await localDb.getAll('categories');
  return rows.length ? rows : ensureDefaultCategories();
}

export async function addCategory({ name, icon }) {
  if (!name || !name.trim()) throw new Error('أدخل اسم التصنيف');
  const record = { id: uuid(), name: name.trim(), icon: icon || '📦', created_at: nowISO() };
  await writeRecord('categories', record);
  return record;
}

export async function updateCategory(id, { name, icon }) {
  const existing = await localDb.getById('categories', id);
  if (!existing) throw new Error('التصنيف غير موجود');
  const updated = { ...existing, name: (name || '').trim() || existing.name, icon: icon || existing.icon };
  await writeRecord('categories', updated);
  return updated;
}

export async function deleteCategory(id) {
  const products = await localDb.getAll('products');
  if (products.some(p => p.category_id === id)) {
    throw new Error('لا يمكن حذف هذا التصنيف لأنه مستخدم بمنتجات. غيّر تصنيف تلك المنتجات أولًا.');
  }
  await localDb.remove('categories', id);
  const s = await getSettings();
  if (s.backendMode === 'supabase' && s.currentShopId) {
    if (navigator.onLine && remoteDb.getClient()) {
      try { await remoteDb.remove('categories', id); }
      catch (e) { await sync.enqueue('categories', 'remove', { id }); }
    } else {
      await sync.enqueue('categories', 'remove', { id });
    }
  }
}

// ---------- المنتجات ----------
export async function getProducts({ activeOnly = false, categoryId = null } = {}) {
  let rows = await localDb.getAll('products');
  if (activeOnly) rows = rows.filter(p => p.is_active !== false);
  if (categoryId) rows = rows.filter(p => p.category_id === categoryId);
  return rows.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar'));
}

export async function getProduct(id) {
  return localDb.getById('products', id);
}

export async function getQuickProducts(limit = 8) {
  const rows = await getProducts({ activeOnly: true });
  const quick = rows.filter(p => p.quick_access);
  if (quick.length) return quick.slice(0, limit);
  return rows.slice(0, limit);
}

export async function addProduct(data) {
  const record = {
    id: uuid(),
    name: data.name.trim(),
    category_id: data.category_id || null,
    icon: data.icon || '',
    unit: data.unit || 'كغ',
    cost_price: toCents(data.cost_price),
    selling_price: toCents(data.selling_price),
    notes: data.notes || '',
    quick_access: !!data.quick_access,
    is_active: true,
    created_at: nowISO(),
    updated_at: nowISO()
  };
  await writeRecord('products', record);
  await addAudit('product', record.id, 'create', record);
  return record;
}

export async function updateProduct(id, data) {
  const existing = await localDb.getById('products', id);
  if (!existing) throw new Error('المنتج غير موجود');
  const updated = {
    ...existing,
    name: data.name?.trim() ?? existing.name,
    category_id: data.category_id ?? existing.category_id,
    icon: data.icon !== undefined ? data.icon : existing.icon,
    unit: data.unit ?? existing.unit,
    cost_price: data.cost_price !== undefined ? toCents(data.cost_price) : existing.cost_price,
    selling_price: data.selling_price !== undefined ? toCents(data.selling_price) : existing.selling_price,
    notes: data.notes ?? existing.notes,
    quick_access: data.quick_access !== undefined ? !!data.quick_access : existing.quick_access,
    is_active: data.is_active !== undefined ? !!data.is_active : existing.is_active,
    updated_at: nowISO()
  };
  await writeRecord('products', updated);
  await addAudit('product', id, 'update', { before: existing, after: updated });
  return updated;
}

export async function deleteProduct(id) {
  const existing = await localDb.getById('products', id);
  if (!existing) return;
  await updateProduct(id, { is_active: false });
  await addAudit('product', id, 'soft_delete', {});
}

// ---------- الزبائن ----------
export async function getCustomers() {
  const rows = await localDb.getAll('customers');
  return rows.filter(c => !c.is_deleted).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar'));
}

export async function getCustomer(id) {
  if (!id) return null;
  return localDb.getById('customers', id);
}

export async function addCustomer(data) {
  const record = {
    id: uuid(),
    name: data.name.trim(),
    phone: data.phone || '',
    notes: data.notes || '',
    is_deleted: false,
    created_at: nowISO(),
    updated_at: nowISO()
  };
  await writeRecord('customers', record);
  await addAudit('customer', record.id, 'create', record);
  return record;
}

export async function updateCustomer(id, data) {
  const existing = await localDb.getById('customers', id);
  if (!existing) throw new Error('الزبون غير موجود');
  const updated = { ...existing, ...data, updated_at: nowISO() };
  await writeRecord('customers', updated);
  await addAudit('customer', id, 'update', { before: existing, after: updated });

  // اسم الزبون محفوظ كنسخة مستقلة (customer_name_snapshot) بكل فاتورة قديمة، فلما يتغير اسمه
  // لازم نحدّث كل فواتيره السابقة كمان حتى يظهر بالاسم الجديد بالفواتير والداشبورد والتقارير
  if (data.name && data.name !== existing.name) {
    const sales = await localDb.getByIndex('sales', 'customer_id', id);
    for (const sale of sales) {
      if (sale.customer_name_snapshot !== updated.name) {
        await writeRecord('sales', { ...sale, customer_name_snapshot: updated.name });
      }
    }
  }

  return updated;
}

export async function deleteCustomer(id) {
  const balance = await getCustomerBalance(id);
  if (balance !== 0) {
    throw new Error('لا يمكن حذف زبون لديه رصيد مستحق. قم بتسوية الحساب أولاً.');
  }
  await updateCustomer(id, { is_deleted: true });
  await addAudit('customer', id, 'soft_delete', {});
}

// رصيد الزبون = إجمالي حصص الدين من المبيعات - إجمالي الدفعات (يُعاد حسابه دائمًا من السجل)
export async function getCustomerBalance(customerId) {
  if (!customerId) return 0;
  const sales = await localDb.getByIndex('sales', 'customer_id', customerId);
  const payments = await localDb.getByIndex('payments', 'customer_id', customerId);
  const debtTotal = sales.filter(s => !s.is_deleted).reduce((sum, s) => sum + (s.paid_debt || 0), 0);
  const paidTotal = payments.filter(p => !p.is_deleted).reduce((sum, p) => sum + (p.amount || 0), 0);
  return debtTotal - paidTotal;
}

export async function getCustomersWithBalance() {
  const customers = await getCustomers();
  const withBalance = await Promise.all(customers.map(async c => ({ ...c, balance: await getCustomerBalance(c.id) })));
  return withBalance;
}

export async function getTotalOutstandingDebt() {
  const customers = await getCustomers();
  let total = 0;
  for (const c of customers) total += Math.max(0, await getCustomerBalance(c.id));
  return total;
}

export async function getCustomerLedger(customerId) {
  const sales = (await localDb.getByIndex('sales', 'customer_id', customerId)).filter(s => !s.is_deleted && s.paid_debt > 0);
  const payments = (await localDb.getByIndex('payments', 'customer_id', customerId)).filter(p => !p.is_deleted);
  const entries = [
    ...sales.map(s => ({
      type: 'sale', id: s.id, date: s.created_at, amount: s.paid_debt,
      label: `فاتورة ${s.invoice_number}`, direction: 'debt'
    })),
    ...payments.map(p => ({
      type: 'payment', id: p.id, date: p.created_at, amount: p.amount,
      label: p.method === 'cash' ? 'دفعة نقدية' : 'دفعة تحويل', direction: 'payment', notes: p.notes
    }))
  ];
  return entries.sort((a, b) => b.date.localeCompare(a.date));
}

// ---------- المبيعات ----------
function computeSaleTotals(items) {
  let subtotal = 0, totalCost = 0, totalProfit = 0;
  const normalizedItems = items.map(it => {
    const qty = parseFloat(it.quantity) || 0;
    const sellingPriceCents = toCents(it.selling_price);
    const costPriceCents = toCents(it.cost_price);
    const totalPrice = Math.round(sellingPriceCents * qty);
    const totalCostItem = Math.round(costPriceCents * qty);
    const profit = totalPrice - totalCostItem;
    subtotal += totalPrice;
    totalCost += totalCostItem;
    totalProfit += profit;
    return {
      id: uuid(),
      product_id: it.product_id || null,
      product_name: it.product_name,
      quantity: qty,
      unit: it.unit,
      cost_price: costPriceCents,
      selling_price: sellingPriceCents,
      total_cost: totalCostItem,
      total_price: totalPrice,
      profit
    };
  });
  return { normalizedItems, subtotal, totalCost, totalProfit };
}

export async function createSale(payload) {
  return withInvoiceLock(async () => {
    if (!payload.items || !payload.items.length) throw new Error('أضف منتجًا واحدًا على الأقل');
    const { normalizedItems, subtotal, totalCost, totalProfit } = computeSaleTotals(payload.items);

    const paidCash = toCents(payload.paidCash || 0);
    const paidTransfer = toCents(payload.paidTransfer || 0);
    const paidDebt = toCents(payload.paidDebt || 0);
    const paymentSum = paidCash + paidTransfer + paidDebt;

    if (Math.abs(paymentSum - subtotal) > 1) {
      throw new Error('مجموع طرق الدفع لا يساوي إجمالي الفاتورة');
    }
    if (paidDebt > 0 && !payload.customerId) {
      throw new Error('يجب اختيار زبون قبل تسجيل الدين');
    }

    const { number, label } = await nextInvoiceLabel();
    const paymentStatus = paidDebt > 0 ? (paidCash + paidTransfer > 0 ? 'partial' : 'debt') : 'paid';
    const createdAt = payload.createdAt || nowISO();

    const sale = {
      id: uuid(),
      invoice_number: label,
      invoice_seq: number,
      customer_id: payload.customerId || null,
      customer_name_snapshot: payload.customerName || 'زبون بدون اسم',
      subtotal, total_cost: totalCost, total_profit: totalProfit, total_amount: subtotal,
      paid_cash: paidCash, paid_transfer: paidTransfer, paid_debt: paidDebt,
      transfer_reference: payload.transferReference || '',
      transfer_bank: payload.transferBank || '',
      payment_status: paymentStatus,
      notes: payload.notes || '',
      is_deleted: false,
      created_by: (await getSettings()).currentUser?.name || 'مستخدم محلي',
      created_at: createdAt,
      updated_at: createdAt,
      edit_history: []
    };
    await writeRecord('sales', sale);
    for (const item of normalizedItems) {
      item.sale_id = sale.id;
      await writeRecord('saleItems', item);
    }
    if (paidCash > 0) {
      await writeRecord('cashTransactions', {
        id: uuid(), type: 'sale_cash', amount: paidCash, reference_type: 'sale', reference_id: sale.id,
        notes: `بيع - ${label}`, created_at: sale.created_at
      });
    }
    await addAudit('sale', sale.id, 'create', sale);
    return { sale, items: normalizedItems };
  });
}

export async function getSaleItems(saleId) {
  return localDb.getByIndex('saleItems', 'sale_id', saleId);
}

export async function getSale(id) {
  const sale = await localDb.getById('sales', id);
  if (!sale) return null;
  const items = await getSaleItems(id);
  return { ...sale, items };
}

export async function getSales({ from, to, customerId } = {}) {
  let rows = await localDb.getAll('sales');
  rows = rows.filter(s => !s.is_deleted);
  if (from) rows = rows.filter(s => new Date(s.created_at) >= from);
  if (to) rows = rows.filter(s => new Date(s.created_at) <= to);
  if (customerId) rows = rows.filter(s => s.customer_id === customerId);
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getRecentSales(limit = 10) {
  const rows = await getSales();
  return rows.slice(0, limit);
}

export async function updateSale(id, payload) {
  const existing = await getSale(id);
  if (!existing) throw new Error('الفاتورة غير موجودة');
  const { normalizedItems, subtotal, totalCost, totalProfit } = computeSaleTotals(payload.items);
  const paidCash = toCents(payload.paidCash || 0);
  const paidTransfer = toCents(payload.paidTransfer || 0);
  const paidDebt = toCents(payload.paidDebt || 0);
  if (Math.abs(paidCash + paidTransfer + paidDebt - subtotal) > 1) {
    throw new Error('مجموع طرق الدفع لا يساوي إجمالي الفاتورة');
  }
  if (paidDebt > 0 && !payload.customerId) throw new Error('يجب اختيار زبون قبل تسجيل الدين');

  for (const old of existing.items) await localDb.remove('saleItems', old.id);
  for (const item of normalizedItems) { item.sale_id = id; await writeRecord('saleItems', item); }

  const paymentStatus = paidDebt > 0 ? (paidCash + paidTransfer > 0 ? 'partial' : 'debt') : 'paid';
  const updated = {
    ...existing,
    customer_id: payload.customerId || null,
    customer_name_snapshot: payload.customerName || existing.customer_name_snapshot,
    subtotal, total_cost: totalCost, total_profit: totalProfit, total_amount: subtotal,
    paid_cash: paidCash, paid_transfer: paidTransfer, paid_debt: paidDebt,
    payment_status: paymentStatus,
    notes: payload.notes ?? existing.notes,
    updated_at: nowISO(),
    edit_history: [...(existing.edit_history || []), { at: nowISO(), by: (await getSettings()).currentUser?.name || 'مستخدم محلي' }]
  };
  delete updated.items;
  await writeRecord('sales', updated);

  // تصحيح حركة الصندوق: نحذف حركة الكاش القديمة للفاتورة ونضيف الجديدة إن وجدت
  const oldCashTx = (await localDb.getAll('cashTransactions')).filter(t => t.reference_type === 'sale' && t.reference_id === id);
  for (const t of oldCashTx) await localDb.remove('cashTransactions', t.id);
  if (paidCash > 0) {
    await writeRecord('cashTransactions', {
      id: uuid(), type: 'sale_cash', amount: paidCash, reference_type: 'sale', reference_id: id,
      notes: `تعديل فاتورة - ${existing.invoice_number}`, created_at: nowISO()
    });
  }
  await addAudit('sale', id, 'update', { before: existing, after: updated });
  return updated;
}

export async function deleteSale(id) {
  const existing = await localDb.getById('sales', id);
  if (!existing) return;
  await writeRecord('sales', { ...existing, is_deleted: true, updated_at: nowISO() });
  const oldCashTx = (await localDb.getAll('cashTransactions')).filter(t => t.reference_type === 'sale' && t.reference_id === id);
  for (const t of oldCashTx) await localDb.remove('cashTransactions', t.id);
  await addAudit('sale', id, 'soft_delete', {});
}

// ---------- الدفعات (تحصيل الديون) ----------
export async function addPayment({ customerId, amount, method, referenceNumber, bankName, notes, createdAt }) {
  if (!customerId) throw new Error('يجب اختيار زبون');
  const amountCents = toCents(amount);
  if (amountCents <= 0) throw new Error('أدخل مبلغًا صحيحًا');
  const record = {
    id: uuid(), customer_id: customerId, sale_id: null, amount: amountCents,
    method: method === 'transfer' ? 'transfer' : 'cash',
    reference_number: referenceNumber || '', bank_name: bankName || '', notes: notes || '',
    is_deleted: false, created_at: createdAt || nowISO()
  };
  await writeRecord('payments', record);
  if (record.method === 'cash') {
    await writeRecord('cashTransactions', {
      id: uuid(), type: 'payment_cash', amount: amountCents, reference_type: 'payment', reference_id: record.id,
      notes: 'تحصيل دين نقدي', created_at: record.created_at
    });
  }
  await addAudit('payment', record.id, 'create', record);
  return record;
}

export async function getPayments({ from, to, customerId } = {}) {
  let rows = await localDb.getAll('payments');
  rows = rows.filter(p => !p.is_deleted);
  if (from) rows = rows.filter(p => new Date(p.created_at) >= from);
  if (to) rows = rows.filter(p => new Date(p.created_at) <= to);
  if (customerId) rows = rows.filter(p => p.customer_id === customerId);
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function deletePayment(id) {
  const existing = await localDb.getById('payments', id);
  if (!existing) return;
  await writeRecord('payments', { ...existing, is_deleted: true });
  const oldCashTx = (await localDb.getAll('cashTransactions')).filter(t => t.reference_type === 'payment' && t.reference_id === id);
  for (const t of oldCashTx) await localDb.remove('cashTransactions', t.id);
  await addAudit('payment', id, 'soft_delete', {});
}

// ---------- التحويلات (مُجمّعة من المبيعات + الدفعات) ----------
export async function getTransfers({ from, to } = {}) {
  const sales = (await getSales({ from, to })).filter(s => s.paid_transfer > 0);
  const payments = (await getPayments({ from, to })).filter(p => p.method === 'transfer');
  const items = [
    ...sales.map(s => ({
      id: s.id, source: 'sale', customerName: s.customer_name_snapshot, amount: s.paid_transfer,
      date: s.created_at, referenceNumber: s.transfer_reference, bank: s.transfer_bank, notes: `فاتورة ${s.invoice_number}`
    })),
    ...payments.map(p => ({
      id: p.id, source: 'payment', customerName: null, customerId: p.customer_id, amount: p.amount,
      date: p.created_at, referenceNumber: p.reference_number, bank: p.bank_name, notes: p.notes
    }))
  ];
  return items.sort((a, b) => b.date.localeCompare(a.date));
}

// ---------- المصروفات ----------
export async function addExpense({ amount, category, notes, createdAt }) {
  const amountCents = toCents(amount);
  if (amountCents <= 0) throw new Error('أدخل مبلغًا صحيحًا');
  const record = { id: uuid(), amount: amountCents, category: category || 'أخرى', notes: notes || '', is_deleted: false, created_at: createdAt || nowISO() };
  await writeRecord('expenses', record);
  await writeRecord('cashTransactions', {
    id: uuid(), type: 'expense', amount: -amountCents, reference_type: 'expense', reference_id: record.id,
    notes: `مصروف - ${record.category}`, created_at: record.created_at
  });
  await addAudit('expense', record.id, 'create', record);
  return record;
}

export async function getExpenses({ from, to } = {}) {
  let rows = await localDb.getAll('expenses');
  rows = rows.filter(e => !e.is_deleted);
  if (from) rows = rows.filter(e => new Date(e.created_at) >= from);
  if (to) rows = rows.filter(e => new Date(e.created_at) <= to);
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function deleteExpense(id) {
  const existing = await localDb.getById('expenses', id);
  if (!existing) return;
  await writeRecord('expenses', { ...existing, is_deleted: true });
  const oldCashTx = (await localDb.getAll('cashTransactions')).filter(t => t.reference_type === 'expense' && t.reference_id === id);
  for (const t of oldCashTx) await localDb.remove('cashTransactions', t.id);
  await addAudit('expense', id, 'soft_delete', {});
}

// ---------- الصندوق ----------
export async function getCashSummary({ from, to } = {}) {
  const settings = await getSettings();
  const sales = await getSales({ from, to });
  const payments = await getPayments({ from, to });
  const expenses = await getExpenses({ from, to });

  const cashSales = sales.reduce((s, x) => s + (x.paid_cash || 0), 0);
  const transferSales = sales.reduce((s, x) => s + (x.paid_transfer || 0), 0);
  const debtSales = sales.reduce((s, x) => s + (x.paid_debt || 0), 0);
  const cashPayments = payments.filter(p => p.method === 'cash').reduce((s, x) => s + x.amount, 0);
  const transferPayments = payments.filter(p => p.method === 'transfer').reduce((s, x) => s + x.amount, 0);
  const totalExpenses = expenses.reduce((s, x) => s + x.amount, 0);

  const opening = settings.openingCashBalance || 0;
  const expectedCash = opening + cashSales + cashPayments - totalExpenses;

  return {
    opening, cashSales, transferSales, debtSales, cashPayments, transferPayments, totalExpenses,
    expectedCash, totalCash: cashSales + cashPayments, totalTransfer: transferSales + transferPayments
  };
}

// ---------- التقارير ----------
export async function getReportSummary({ from, to } = {}) {
  const sales = await getSales({ from, to });
  const payments = await getPayments({ from, to });
  const expenses = await getExpenses({ from, to });

  const totalSales = sales.reduce((s, x) => s + x.total_amount, 0);
  const totalCost = sales.reduce((s, x) => s + x.total_cost, 0);
  const grossProfit = sales.reduce((s, x) => s + x.total_profit, 0);
  const totalExpenses = expenses.reduce((s, x) => s + x.amount, 0);
  const netProfit = grossProfit - totalExpenses;
  const totalCash = sales.reduce((s, x) => s + x.paid_cash, 0);
  const totalTransfer = sales.reduce((s, x) => s + x.paid_transfer, 0);
  const totalDebtNew = sales.reduce((s, x) => s + x.paid_debt, 0);
  const debtCollected = payments.reduce((s, x) => s + x.amount, 0);
  const invoiceCount = sales.length;
  const avgSale = invoiceCount ? Math.round(totalSales / invoiceCount) : 0;

  return { totalSales, totalCost, grossProfit, netProfit, totalExpenses, totalCash, totalTransfer, totalDebtNew, debtCollected, invoiceCount, avgSale };
}

export async function getTopProducts({ from, to, limit = 10 } = {}) {
  const sales = await getSales({ from, to });
  const map = new Map();
  for (const sale of sales) {
    const items = await getSaleItems(sale.id);
    for (const it of items) {
      const key = it.product_name;
      const agg = map.get(key) || { name: key, unit: it.unit, quantity: 0, sales: 0, profit: 0 };
      agg.quantity += it.quantity;
      agg.sales += it.total_price;
      agg.profit += it.profit;
      map.set(key, agg);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.sales - a.sales).slice(0, limit);
}

// المخزون: كل صنف نشط بالمحل مع كمية مبيعاته اليوم (0 لو ما بيع منه شي)، لمعرفة أكثر الأصناف حركة
export async function getInventorySoldToday() {
  const from = startOfDay(), to = endOfDay();
  const [products, sales] = await Promise.all([getProducts({ activeOnly: true }), getSales({ from, to })]);
  const soldMap = new Map();
  for (const sale of sales) {
    const items = await getSaleItems(sale.id);
    for (const it of items) {
      if (!it.product_id) continue;
      soldMap.set(it.product_id, (soldMap.get(it.product_id) || 0) + it.quantity);
    }
  }
  return products
    .map(p => ({ id: p.id, name: p.name, unit: p.unit, category_id: p.category_id, soldToday: soldMap.get(p.id) || 0 }))
    .sort((a, b) => b.soldToday - a.soldToday || a.name.localeCompare(b.name, 'ar'));
}

export async function getProfitByDay({ from, to }) {
  const sales = await getSales({ from, to });
  const dayMap = new Map();
  for (const s of sales) {
    const day = s.created_at.slice(0, 10);
    dayMap.set(day, (dayMap.get(day) || 0) + s.total_profit);
  }
  return Array.from(dayMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([day, profit]) => ({ day, profit }));
}

export async function getTodayStats() {
  const from = startOfDay(), to = endOfDay();
  const sales = await getSales({ from, to });
  const totalSales = sales.reduce((s, x) => s + x.total_amount, 0);
  const netProfitGross = sales.reduce((s, x) => s + x.total_profit, 0);
  const todayExpenses = (await getExpenses({ from, to })).reduce((s, x) => s + x.amount, 0);
  const cash = sales.reduce((s, x) => s + x.paid_cash, 0);
  const transfer = sales.reduce((s, x) => s + x.paid_transfer, 0);
  const debt = sales.reduce((s, x) => s + x.paid_debt, 0);
  return { totalSales, netProfit: netProfitGross - todayExpenses, cash, transfer, debt, invoiceCount: sales.length };
}

// ---------- النسخ الاحتياطي ----------
export async function exportBackup() {
  const data = await localDb.exportAllData();
  return { app: 'hesabaty', version: 1, exported_at: nowISO(), data };
}

export async function importBackup(json) {
  if (!json || json.app !== 'hesabaty' || !json.data) throw new Error('ملف النسخة الاحتياطية غير صالح');
  await localDb.importAllData(json.data);
  settingsCache = null;
  await getSettings();
}

export async function wipeLocalData() {
  await localDb.clearAll();
  settingsCache = null;
}

export { sync };
