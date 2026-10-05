// التقارير: ملخص، أكثر المنتجات مبيعًا، رسم بياني للأرباح
import * as db from './database.js';
import { getCurrentUser, canViewProfit } from './auth.js';
import { formatMoney, formatNumber, fromCents, dateRangeFor, startOfDay, endOfDay, escapeHtml } from './utils.js';
import { emptyState, toastSuccess } from './ui.js';

let currentPreset = 'today';
let customFrom = null, customTo = null;
let chartInstance = null;
let lastReportData = null;

const PRESETS = [
  ['today', 'اليوم'], ['yesterday', 'أمس'], ['last7', 'آخر 7 أيام'],
  ['month', 'هذا الشهر'], ['prevMonth', 'الشهر السابق'], ['custom', 'فترة مخصصة']
];

export async function renderReports(container) {
  container.innerHTML = `<div class="skeleton" style="height:300px;"></div>`;
  await renderForPreset(container, currentPreset);
}

function getRange(preset) {
  if (preset === 'custom' && customFrom && customTo) return { from: startOfDay(new Date(customFrom)), to: endOfDay(new Date(customTo)) };
  return dateRangeFor(preset === 'custom' ? 'today' : preset);
}

async function renderForPreset(container, preset) {
  currentPreset = preset;
  const range = getRange(preset);
  const [summary, topProducts, profitByDay, user] = await Promise.all([
    db.getReportSummary(range), db.getTopProducts({ ...range, limit: 8 }), db.getProfitByDay(range), getCurrentUser()
  ]);
  const showProfit = canViewProfit(user);
  lastReportData = { range, summary, topProducts, showProfit };

  container.innerHTML = `
    <div class="tabs">
      ${PRESETS.map(([k, l]) => `<button class="tab-btn ${preset === k ? 'active' : ''}" data-preset="${k}">${l}</button>`).join('')}
    </div>
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px;">
      <button class="btn btn-secondary" id="export-csv-btn" style="padding:6px 12px;font-size:13px;">⬇️ تصدير CSV</button>
    </div>
    ${preset === 'custom' ? `
    <div class="card" style="display:flex;gap:8px;align-items:end;">
      <div class="form-group" style="flex:1;margin-bottom:0;"><label>من</label><input type="date" id="custom-from" value="${customFrom || ''}"></div>
      <div class="form-group" style="flex:1;margin-bottom:0;"><label>إلى</label><input type="date" id="custom-to" value="${customTo || ''}"></div>
      <button class="btn btn-primary" id="apply-custom">تطبيق</button>
    </div>` : ''}

    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">🧾 إجمالي المبيعات</div><div class="stat-value">${formatMoney(summary.totalSales)}</div></div>
      ${showProfit ? `<div class="stat-card profit"><div class="stat-label">📈 صافي الربح</div><div class="stat-value">${formatMoney(summary.netProfit)}</div></div>` : ''}
      <div class="stat-card cash"><div class="stat-label">💵 النقد</div><div class="stat-value">${formatMoney(summary.totalCash)}</div></div>
      <div class="stat-card transfer"><div class="stat-label">📱 التحويلات</div><div class="stat-value">${formatMoney(summary.totalTransfer)}</div></div>
      <div class="stat-card debt"><div class="stat-label">📝 مبيعات آجلة</div><div class="stat-value">${formatMoney(summary.totalDebtNew)}</div></div>
      <div class="stat-card"><div class="stat-label">✅ محصّل من الديون</div><div class="stat-value">${formatMoney(summary.debtCollected)}</div></div>
      ${showProfit ? `<div class="stat-card"><div class="stat-label">💲 إجمالي التكلفة</div><div class="stat-value">${formatMoney(summary.totalCost)}</div></div>
      <div class="stat-card"><div class="stat-label">💸 المصروفات</div><div class="stat-value">${formatMoney(summary.totalExpenses)}</div></div>` : ''}
      <div class="stat-card"><div class="stat-label">🧮 عدد الفواتير</div><div class="stat-value">${summary.invoiceCount}</div></div>
      <div class="stat-card"><div class="stat-label">📊 متوسط الفاتورة</div><div class="stat-value">${formatMoney(summary.avgSale)}</div></div>
    </div>

    ${showProfit ? `
    <div class="section-title">الأرباح حسب الأيام</div>
    <div class="card"><canvas id="profit-chart" height="180"></canvas></div>` : ''}

    <div class="section-title">أكثر المنتجات مبيعًا</div>
    <div class="card" style="padding:6px 10px;">
      ${topProducts.length ? topProducts.map((p, i) => topProductRow(p, i, showProfit)).join('') : emptyState('📦', 'لا توجد مبيعات في هذه الفترة')}
    </div>
  `;

  container.querySelector('#export-csv-btn').onclick = () => exportReportCsv(lastReportData);
  container.querySelectorAll('[data-preset]').forEach(btn => btn.onclick = () => renderForPreset(container, btn.dataset.preset));
  const applyBtn = container.querySelector('#apply-custom');
  if (applyBtn) applyBtn.onclick = () => {
    customFrom = container.querySelector('#custom-from').value;
    customTo = container.querySelector('#custom-to').value;
    if (!customFrom || !customTo) return;
    renderForPreset(container, 'custom');
  };

  if (showProfit) await drawChart(container, profitByDay);
}

function topProductRow(p, index, showProfit) {
  return `
    <div class="list-item">
      <div class="avatar">${index + 1}</div>
      <div class="info">
        <div class="title">${escapeHtml(p.name)}</div>
        <div class="subtitle">${formatNumber(p.quantity)} ${p.unit}</div>
      </div>
      <div style="text-align:left;">
        <div class="amount">${formatMoney(p.sales)}</div>
        ${showProfit ? `<div class="meta" style="color:var(--success);">ربح ${formatMoney(p.profit)}</div>` : ''}
      </div>
    </div>`;
}

async function ensureChartJs() {
  if (window.Chart) return window.Chart;
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js';
    script.onload = () => resolve(window.Chart);
    script.onerror = () => reject(new Error('فشل تحميل مكتبة الرسم البياني'));
    document.head.appendChild(script);
  });
}

async function drawChart(container, profitByDay) {
  const canvas = container.querySelector('#profit-chart');
  if (!canvas) return;
  try {
    const Chart = await ensureChartJs();
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    const labels = profitByDay.map(d => new Date(d.day).toLocaleDateString('ar-EG', { weekday: 'short', day: 'numeric' }));
    const data = profitByDay.map(d => d.profit / 100);
    chartInstance = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: { labels, datasets: [{ label: 'الربح (₪)', data, backgroundColor: '#0d9488', borderRadius: 6 }] },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } }
      }
    });
  } catch (err) {
    canvas.replaceWith(document.createTextNode('تعذر تحميل الرسم البياني (بدون إنترنت لأول مرة)'));
  }
}

function csvField(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function csvRow(fields) { return fields.map(csvField).join(',') + '\r\n'; }

function exportReportCsv(data) {
  if (!data) return;
  const { range, summary, topProducts, showProfit } = data;
  const fmt = (d) => d.toISOString().slice(0, 10);
  let csv = '﻿'; // BOM لضمان ظهور النصوص العربية بشكل صحيح عند فتح الملف ببرامج مثل Excel

  csv += csvRow([`تقرير حساباتي من ${fmt(range.from)} إلى ${fmt(range.to)}`]);
  csv += '\r\n';

  csv += csvRow(['الملخص']);
  csv += csvRow(['إجمالي المبيعات', fromCents(summary.totalSales)]);
  if (showProfit) csv += csvRow(['صافي الربح', fromCents(summary.netProfit)]);
  csv += csvRow(['النقد', fromCents(summary.totalCash)]);
  csv += csvRow(['التحويلات', fromCents(summary.totalTransfer)]);
  csv += csvRow(['مبيعات آجلة', fromCents(summary.totalDebtNew)]);
  csv += csvRow(['محصّل من الديون', fromCents(summary.debtCollected)]);
  if (showProfit) {
    csv += csvRow(['إجمالي التكلفة', fromCents(summary.totalCost)]);
    csv += csvRow(['المصروفات', fromCents(summary.totalExpenses)]);
  }
  csv += csvRow(['عدد الفواتير', summary.invoiceCount]);
  csv += csvRow(['متوسط الفاتورة', fromCents(summary.avgSale)]);
  csv += '\r\n';

  csv += csvRow(['أكثر المنتجات مبيعًا']);
  const header = ['المنتج', 'الكمية', 'الوحدة', 'المبيعات'];
  if (showProfit) header.push('الربح');
  csv += csvRow(header);
  for (const p of topProducts) {
    const row = [p.name, formatNumber(p.quantity), p.unit, fromCents(p.sales)];
    if (showProfit) row.push(fromCents(p.profit));
    csv += csvRow(row);
  }

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `hesabaty-report-${fmt(range.from)}-to-${fmt(range.to)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toastSuccess('تم تصدير التقرير');
}
