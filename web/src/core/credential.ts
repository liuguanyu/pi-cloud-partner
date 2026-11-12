/**
 * 凭据存储（纯 TS，零框架依赖）。
 *
 * 职责单一：只做「读 / 写 / 清空」，不理解配对流程，也不发请求。
 * 换存储介质（IndexedDB / Keychain）时只改这一个文件。
 */

export interface StoredCredentials {
  /** 手机登录凭据（M1 阶段手动提供） */
  userToken?: string;
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
    return next;
  }

  clear(): void {
    this.#storage.removeItem(KEY);
  }

  /** pairToken 是否可用（留 60s 余量，避免边界上刚过期）。 */
  hasFreshPairToken(creds: StoredCredentials, now = Date.now()): boolean {
    if (!creds.pairToken) return false;
    if (!creds.pairTokenExpiresAt) return true;
    return creds.pairTokenExpiresAt - 60_000 > now;
  }
}
