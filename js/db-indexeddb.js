// طبقة تخزين محلية باستخدام IndexedDB
// تعرض واجهة عامة: getAll, get, put, remove, query, clear لكل مخزن (store)
const DB_NAME = 'hesabaty-db';
const DB_VERSION = 1;
export const STORES = [
  'settings', 'customers', 'categories', 'products',
  'sales', 'saleItems', 'payments', 'expenses',
  'cashTransactions', 'auditLog', 'syncQueue'
];

let dbPromise = null;

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('customers')) {
        const s = db.createObjectStore('customers', { keyPath: 'id' });
        s.createIndex('created_at', 'created_at');
      }
      if (!db.objectStoreNames.contains('categories')) db.createObjectStore('categories', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('products')) {
        const s = db.createObjectStore('products', { keyPath: 'id' });
        s.createIndex('category_id', 'category_id');
      }
      if (!db.objectStoreNames.contains('sales')) {
        const s = db.createObjectStore('sales', { keyPath: 'id' });
        s.createIndex('created_at', 'created_at');
        s.createIndex('customer_id', 'customer_id');
        s.createIndex('invoice_number', 'invoice_number');
      }
      if (!db.objectStoreNames.contains('saleItems')) {
        const s = db.createObjectStore('saleItems', { keyPath: 'id' });
        s.createIndex('sale_id', 'sale_id');
        s.createIndex('product_id', 'product_id');
      }
      if (!db.objectStoreNames.contains('payments')) {
        const s = db.createObjectStore('payments', { keyPath: 'id' });
        s.createIndex('created_at', 'created_at');
        s.createIndex('customer_id', 'customer_id');
      }
      if (!db.objectStoreNames.contains('expenses')) {
        const s = db.createObjectStore('expenses', { keyPath: 'id' });
        s.createIndex('created_at', 'created_at');
      }
      if (!db.objectStoreNames.contains('cashTransactions')) {
        const s = db.createObjectStore('cashTransactions', { keyPath: 'id' });
        s.createIndex('created_at', 'created_at');
      }
      if (!db.objectStoreNames.contains('auditLog')) {
        const s = db.createObjectStore('auditLog', { keyPath: 'id' });
        s.createIndex('created_at', 'created_at');
      }
      if (!db.objectStoreNames.contains('syncQueue')) {
        db.createObjectStore('syncQueue', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function withStore(storeName, mode, callback) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    Promise.resolve(callback(store)).then((r) => { result = r; }).catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(storeName) {
  return withStore(storeName, 'readonly', (store) => reqToPromise(store.getAll()));
}

export async function getById(storeName, id) {
  return withStore(storeName, 'readonly', (store) => reqToPromise(store.get(id)));
}

export async function put(storeName, record) {
  return withStore(storeName, 'readwrite', (store) => reqToPromise(store.put(record))).then(() => record);
}

export async function bulkPut(storeName, records) {
  return withStore(storeName, 'readwrite', async (store) => {
    for (const r of records) store.put(r);
  });
}

export async function remove(storeName, id) {
  return withStore(storeName, 'readwrite', (store) => reqToPromise(store.delete(id)));
}

export async function getByIndex(storeName, indexName, value) {
  return withStore(storeName, 'readonly', (store) => reqToPromise(store.index(indexName).getAll(value)));
}

export async function clearStore(storeName) {
  return withStore(storeName, 'readwrite', (store) => reqToPromise(store.clear()));
}

export async function clearAll() {
  for (const name of STORES) await clearStore(name);
}

export async function exportAllData() {
  const data = {};
  for (const name of STORES) data[name] = await getAll(name);
  return data;
}

export async function importAllData(data) {
  for (const name of STORES) {
    if (Array.isArray(data[name])) await bulkPut(name, data[name]);
  }
}
