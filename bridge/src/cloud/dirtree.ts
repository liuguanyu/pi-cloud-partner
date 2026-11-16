/**
 * 扫描白名单根目录下的子目录，供手机端做选择器。
 *
 * 为什么需要：pi 是按目录工作的，白名单里通常只有一个 `~/devspace` 这样的根，
 * 而真正要干活的是它下面某个仓库。只给根目录，手机端就只能手打绝对路径。
 *
 * 边界：
 *   - 只扫**白名单内**的目录（不越界）
 *   - 深度 ≤ 2（`devspace/repo` 这一层够用；再深就靠手动输入）
 *   - 跳过 `node_modules`/`dist`/隐藏目录这类噪音
 *   - 条数上限，避免大目录把 hello 帧撑爆
 */
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface DirEntry {
  /** 绝对路径 */
  path: string;
  name: string;
  /** 0 = 白名单根目录，1 = 一级子目录，2 = 二级 */
  depth: number;
  /** 是否 git 仓库（手机端优先展示） */
  isGit: boolean;
}

const SKIP_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "Library",
  "Applications",
  ".git",
  ".cache",
  ".Trash",
]);

// 分层预算：一级全收（选择器的主体），二级只对 git 仓库下钻且限量，
// 否则第一个 monorepo 的子目录会把其它仓库全挤掉。
const MAX_DEPTH1 = 400;
const MAX_DEPTH2 = 120;
const MAX_CHILDREN_PER_REPO = 6;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function scanWorkspaces(roots: string[]): Promise<DirEntry[]> {
  const roots_out: DirEntry[] = [];
  const level1: DirEntry[] = [];

  // ── 第一层：根目录 + 一级子目录（选择器主体）──
  for (const root of roots) {
    if (!existsSync(root)) continue;
    roots_out.push({ path: root, name: baseName(root), depth: 0, isGit: existsSync(join(root, ".git")) });

    for (const name of await listDirs(root)) {
      if (level1.length >= MAX_DEPTH1) break;
      const full = join(root, name);
      level1.push({ path: full, name, depth: 1, isGit: existsSync(join(full, ".git")) });
    }
  }

  // ── 第二层：只对 git 仓库下钻，且每个仓库限量 ──
  const level2: DirEntry[] = [];
  for (const repo of level1) {
    if (level2.length >= MAX_DEPTH2) break;
    if (!repo.isGit) continue;
    let taken = 0;
    for (const name of await listDirs(repo.path)) {
      if (taken >= MAX_CHILDREN_PER_REPO || level2.length >= MAX_DEPTH2) break;
      // 仓库里的二级目录多数是源码子包，标成非 git（除非自己有 .git）
      const full = join(repo.path, name);
      level2.push({ path: full, name, depth: 2, isGit: existsSync(join(full, ".git")) });
      taken += 1;
    }
  }

  // git 仓库优先（手机端最常选的就是仓库），其余按名字
  const order = (a: DirEntry, b: DirEntry): number => {
    if (a.isGit !== b.isGit) return a.isGit ? -1 : 1;
    return a.name.localeCompare(b.name);
  };
  level1.sort(order);
  level2.sort(order);

  return [...roots_out, ...level1, ...level2];
}

/** 列出一个目录下的子目录名（跳过噪音与隐藏目录）。 */
async function listDirs(parent: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return [];
  }
  names.sort();
  const out: string[] = [];
  for (const name of names) {
    if (name.startsWith(".") || SKIP_NAMES.has(name)) continue;
    if (await isDirectory(join(parent, name))) out.push(name);
  }
  return out;
}

function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
