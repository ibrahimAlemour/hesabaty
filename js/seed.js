// بيانات تجريبية للتجربة الأولى فقط (Demo/Seed) - لا تُستخدم بعد ربط سوبابيس ببيانات حقيقية
import * as db from './database.js';
import { addDays } from './utils.js';

const PRODUCTS = [
  { name: 'لحم بلدي', category_name: 'لحوم', unit: 'كغ', cost_price: 35, selling_price: 45, quick_access: true },
  { name: 'لحم مفروم', category_name: 'لحوم', unit: 'كغ', cost_price: 32, selling_price: 42, quick_access: true },
  { name: 'دجاج', category_name: 'دجاج', unit: 'كغ', cost_price: 14, selling_price: 18, quick_access: true },
  { name: 'بندورة', category_name: 'خضار', unit: 'كغ', cost_price: 2.5, selling_price: 4, quick_access: true },
  { name: 'خيار', category_name: 'خضار', unit: 'كغ', cost_price: 2, selling_price: 3.5, quick_access: true },
  { name: 'بطاطا', category_name: 'خضار', unit: 'كغ', cost_price: 2, selling_price: 3, quick_access: true },
  { name: 'بصل', category_name: 'خضار', unit: 'كغ', cost_price: 1.5, selling_price: 2.5 },
  { name: 'فلفل', category_name: 'خضار', unit: 'كغ', cost_price: 3, selling_price: 5 },
  { name: 'تفاح', category_name: 'فواكه', unit: 'كغ', cost_price: 5, selling_price: 8 },
  { name: 'موز', category_name: 'فواكه', unit: 'كغ', cost_price: 4, selling_price: 6.5 }
];

const CUSTOMERS = [
  { name: 'أحمد محمد', phone: '0599111222' },
  { name: 'محمود أبو علي', phone: '0599222333' },
  { name: 'أبو محمد', phone: '0599333444' },
  { name: 'سامر خليل', phone: '0599444555' },
  { name: 'أم يوسف', phone: '0599555666' },
  { name: 'خالد نصار', phone: '0599666777' },
  { name: 'رامي عودة', phone: '' },
  { name: 'إياد سالم', phone: '0599888999' },
  { name: 'أبو سامي', phone: '' },
  { name: 'نادية حسن', phone: '0599777888' }
];

export async function loadSeedData() {
  const settings = await db.getSettings();
  if (settings.seedLoaded) return;

  const categories = await db.ensureDefaultCategories();
  const catIdByName = new Map(categories.map(c => [c.name, c.id]));

  const createdProducts = [];
  for (const p of PRODUCTS) {
    const { category_name, ...rest } = p;
    createdProducts.push(await db.addProduct({ ...rest, category_id: catIdByName.get(category_name) }));
  }

  const createdCustomers = [];
  for (const c of CUSTOMERS) createdCustomers.push(await db.addCustomer(c));

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const paymentMethods = ['cash', 'transfer', 'debt'];

  for (let dayOffset = 6; dayOffset >= 0; dayOffset--) {
    const day = addDays(new Date(), -dayOffset);
    const salesCountToday = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < salesCountToday; i++) {
      const itemCount = 1 + Math.floor(Math.random() * 3);
      const items = [];
      for (let k = 0; k < itemCount; k++) {
        const prod = pick(createdProducts);
        const qty = Math.round((0.5 + Math.random() * 3) * 2) / 2;
        items.push({
          product_id: prod.id, product_name: prod.name, quantity: qty, unit: prod.unit,
          cost_price: prod.cost_price / 100, selling_price: prod.selling_price / 100
        });
      }
      const subtotalCents = items.reduce((s, it) => s + Math.round((it.selling_price * 100) * it.quantity), 0);
      const method = pick(paymentMethods);
      const useCashier = Math.random() > 0.5;
      const customer = useCashier ? null : pick(createdCustomers);
      const saleTime = new Date(day);
      saleTime.setHours(9 + Math.floor(Math.random() * 11), Math.floor(Math.random() * 60));

      let paidCash = 0, paidTransfer = 0, paidDebt = 0;
      if (method === 'cash') paidCash = subtotalCents / 100;
      else if (method === 'transfer') paidTransfer = subtotalCents / 100;
      else if (customer) paidDebt = subtotalCents / 100;
      else paidCash = subtotalCents / 100;

      await db.createSale({
        customerId: customer ? customer.id : null,
        customerName: customer ? customer.name : 'زبون بدون اسم',
        items,
        paidCash, paidTransfer, paidDebt,
        transferReference: paidTransfer ? `TR-${Math.floor(1000 + Math.random() * 9000)}` : '',
        transferBank: paidTransfer ? pick(['بنك فلسطين', 'البنك الإسلامي', 'بنك القاهرة عمان']) : '',
        createdAt: saleTime.toISOString()
      });
    }
  }

  // بعض الدفعات على الديون
  for (let i = 0; i < 4; i++) {
    const customer = pick(createdCustomers);
    const balance = await db.getCustomerBalance(customer.id);
    if (balance > 500) {
      const payDay = addDays(new Date(), -Math.floor(Math.random() * 5));
      await db.addPayment({
        customerId: customer.id, amount: Math.round(balance / 100 / 2), method: pick(['cash', 'transfer']),
        notes: 'دفعة جزئية', createdAt: payDay.toISOString()
      });
    }
  }

  // بعض المصروفات
  const expenses = [
    { amount: 150, category: 'نقل', notes: 'نقل بضاعة' },
    { amount: 80, category: 'كهرباء', notes: '' },
    { amount: 300, category: 'بضاعة', notes: 'شراء دفعة خضار' },
    { amount: 50, category: 'صيانة', notes: 'صيانة ثلاجة' }
  ];
  for (const e of expenses) {
    const expDay = addDays(new Date(), -Math.floor(Math.random() * 6));
    await db.addExpense({ ...e, createdAt: expDay.toISOString() });
  }

  await db.updateSettings({ seedLoaded: true, openingCashBalance: 50000 });
}
