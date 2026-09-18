// أدوات مساعدة عامة: الأموال، التاريخ، النصوص، المعرفات
export const CURRENCY = '₪';

// نخزن كل الأموال داخليًا كعدد صحيح (أجورة/فلس = 1/100 شيكل) لتجنب أخطاء الفاصلة العشرية
export function toCents(value) {
  const n = typeof value === 'string' ? parseFloat(value.replace(',', '.')) : value;
  if (!isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function fromCents(cents) {
  return (cents || 0) / 100;
}

export function formatMoney(cents) {
  const n = fromCents(cents);
  const formatted = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${formatted} ${CURRENCY}`;
}

export function formatNumber(n, decimals = 2) {
  const val = Number(n) || 0;
  const hasFraction = Math.abs(val % 1) > 0.001;
  return val.toLocaleString('en-US', { minimumFractionDigits: hasFraction ? decimals : 0, maximumFractionDigits: decimals });
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function nowISO() {
  return new Date().toISOString();
}

const TIMEZONE = () => (window.APP_SETTINGS && window.APP_SETTINGS.timezone) || 'Asia/Gaza';

export function formatDate(iso, opts = {}) {
  const d = new Date(iso);
  return d.toLocaleDateString('ar-EG', { timeZone: TIMEZONE(), day: '2-digit', month: '2-digit', ...(opts.year ? { year: 'numeric' } : {}) });
}

export function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('ar-EG', { timeZone: TIMEZONE(), hour: 'numeric', minute: '2-digit', hour12: true });
}

export function formatDateTime(iso) {
  return `${formatDate(iso)} - ${formatTime(iso)}`;
}

export function todayLabel() {
  const d = new Date();
  return d.toLocaleDateString('ar-EG', { timeZone: TIMEZONE(), weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// حدود بداية/نهاية اليوم بحسب المنطقة الزمنية المحلية للجهاز (تبسيط كافٍ للاستخدام المحلي)
export function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}
export function endOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}
export function startOfWeek(date = new Date()) {
  const d = startOfDay(date);
  const day = d.getDay(); // 0=Sunday
  d.setDate(d.getDate() - day);
  return d;
}
export function startOfMonth(date = new Date()) {
  const d = startOfDay(date);
  d.setDate(1);
  return d;
}
export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function dateRangeFor(preset) {
  const now = new Date();
  switch (preset) {
    case 'today': return { from: startOfDay(now), to: endOfDay(now) };
    case 'yesterday': { const y = addDays(now, -1); return { from: startOfDay(y), to: endOfDay(y) }; }
    case 'last7': return { from: startOfDay(addDays(now, -6)), to: endOfDay(now) };
    case 'month': return { from: startOfMonth(now), to: endOfDay(now) };
    case 'prevMonth': {
      const first = startOfMonth(now);
      const prevLast = addDays(first, -1);
      return { from: startOfMonth(prevLast), to: endOfDay(prevLast) };
    }
    default: return { from: startOfDay(now), to: endOfDay(now) };
  }
}

export function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function normalizeArabic(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ًٌٍَُِّْ]/g, '')
    .trim();
}

export function fuzzyMatch(text, query) {
  if (!query) return true;
  return normalizeArabic(text).includes(normalizeArabic(query));
}

export function debounce(fn, wait = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export function nextInvoiceNumber(lastNumber) {
  const n = (lastNumber || 0) + 1;
  return { number: n, label: `INV-${String(n).padStart(6, '0')}` };
}

export function qs(selector, root = document) { return root.querySelector(selector); }
export function qsa(selector, root = document) { return Array.from(root.querySelectorAll(selector)); }

export function h(strings, ...values) {
  return strings.reduce((acc, s, i) => acc + s + (values[i] !== undefined ? values[i] : ''), '');
}

export const CATEGORY_ICONS = {
  meat: '🥩', chicken: '🍗', vegetables: '🥬', fruits: '🍎', groceries: '🧂', other: '📦'
};
export const CATEGORY_LABELS = {
  meat: 'لحوم', chicken: 'دجاج', vegetables: 'خضار', fruits: 'فواكه', groceries: 'مواد غذائية', other: 'أخرى'
};
export const UNITS = ['كغ', 'غرام', 'حبة', 'صندوق', 'قطعة', 'أخرى'];
export const EXPENSE_CATEGORIES = ['بضاعة', 'نقل', 'كهرباء', 'أجور', 'صيانة', 'أخرى'];
