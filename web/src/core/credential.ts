/**
 * 凭据存储（纯 TS，零框架依赖）。
 *
 * 职责单一：只做「读 / 写 / 清空」，不理解配对流程，也不发请求。
 * 换存储介质（IndexedDB / Keychain）时只改这一个文件。
 */
import { idbDelete, idbGet, idbSet } from "./idb.ts";

export interface StoredCredentials {
  /**
   * 认领者标识：手机自己生成并持久化。
   *
   * L1 起手机不再登录，这个 id 是唯一能区分"同一台手机重试"与"别的手机抢码"的依据。
   * 它不代表身份，只代表"同一个客户端实例"，丢了就当作新手机（会被要求重新配对）。
   */
  claimantId?: string;
  pairId?: string;
  /** 配对后拿到的长期刷新凭据 */
  refreshToken?: string;
  /** 12h 短期凭据 */
  pairToken?: string;
  pairTokenExpiresAt?: number;
}

const KEY = "pcp.credentials.v1";

export class CredentialStore {
  #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  /**
   * localStorage 被系统清掉时从 IndexedDB 自愈。
   *
   * iOS 清存储时 localStorage 先死、IndexedDB 后死（配额大、被视为更重要）。
   * backup 里还有凭据时写回 localStorage，后续逻辑无感继续，不用重新扫码。
   */
  async restoreFromBackup(): Promise<boolean> {
    if (typeof indexedDB === "undefined") return false;
    if (this.#storage.getItem(KEY)) return false;
    try {
      const backup = await idbGet<StoredCredentials>(KEY);
      if (backup && typeof backup === "object" && (backup.refreshToken || backup.pairToken)) {
        this.#storage.setItem(KEY, JSON.stringify(backup));
        return true;
      }
    } catch {
      /* IndexedDB 不可用就算了 */
    }
    return false;
  }

  load(): StoredCredentials {
    try {
      const raw = this.#storage.getItem(KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as StoredCredentials;
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  patch(update: Partial<StoredCredentials>): StoredCredentials {
    const next = { ...this.load(), ...update };
    // 清空字段时真的删掉，避免存一堆 undefined
    for (const key of Object.keys(next) as Array<keyof StoredCredentials>) {
      if (next[key] === undefined) delete next[key];
    }
    this.#storage.setItem(KEY, JSON.stringify(next));
    // 双写 IndexedDB：主存储被清时，它是唯一能救回配对关系的备份
    if (typeof indexedDB !== "undefined") {
      void idbSet(KEY, next).catch(() => {});
    }
    return next;
  }

  clear(): void {
    this.#storage.removeItem(KEY);
    if (typeof indexedDB !== "undefined") {
      void idbDelete(KEY).catch(() => {});
    }
  }

  /** pairToken 是否可用（留 60s 余量，避免边界上刚过期）。 */
  hasFreshPairToken(creds: StoredCredentials, now = Date.now()): boolean {
    if (!creds.pairToken) return false;
    if (!creds.pairTokenExpiresAt) return true;
    return creds.pairTokenExpiresAt - 60_000 > now;
  }
}
