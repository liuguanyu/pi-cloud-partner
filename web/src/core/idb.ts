/**
 * 极简 IndexedDB key/value 封装。
 *
 * 为什么需要它：凭据原本只存 localStorage，而 iOS 清存储时 localStorage 是
 * 最先被清的（配额小、被视为可丢弃）。IndexedDB 配额大、清得更晚，把凭据
 * 在那里也存一份，localStorage 被清掉后能从它自愈 —— 用户无感，不用重新扫码。
 *
 * 注意：如果用户**手动**在系统设置里「清除网站数据」，两个存储都会被清，
 * 那时只能重新配对（安全上也没法绕 —— 见 SPEC 的 L1 信任模型）。
 */

const DB_NAME = "pcp";
const STORE = "kv";
const VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => {
      db.close();
      resolve(req.result as T | undefined);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function idbDelete(key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
