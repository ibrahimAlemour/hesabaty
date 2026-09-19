// أدوات مساعدة خاصة بلوحة المدير العام
export { formatMoney, formatDateTime, formatDate, toCents, fromCents, escapeHtml, fuzzyMatch, debounce, uuid, nowISO } from '../../js/utils.js';

const STATUS_LABELS = {
  active: 'نشط', expired: 'منتهي', overdue: 'متأخر بالدفع', suspended: 'معلّق', pending: 'قيد الإعداد'
};
const STATUS_ICONS = { active: '✅', expired: '⏳', overdue: '⚠️', suspended: '🔒', pending: '🆕' };

// يحسب الحالة الظاهرة للمستخدم بدمج حالة المحل اليدوية مع تاريخ انتهاء آخر اشتراك وفترة السماح
export function computeShopStatus(shop, subscription, gracePeriodDays = 7) {
  if (!shop) return 'pending';
  if (shop.status === 'suspended') return 'suspended';
  if (shop.status === 'pending') return 'pending';
  if (!subscription) return 'pending';

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const end = new Date(subscription.end_date); end.setHours(0, 0, 0, 0);
  const daysLeft = Math.round((end - today) / 86400000);

  if (daysLeft >= 0) return 'active';
  if (daysLeft >= -gracePeriodDays) return 'expired';
  return 'overdue';
}

export function statusLabel(status) { return STATUS_LABELS[status] || status; }
export function statusIcon(status) { return STATUS_ICONS[status] || '•'; }

export function daysUntil(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}
