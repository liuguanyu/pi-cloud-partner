/**
 * 内联图片 → blob 引用 的纯函数改写。
 *
 * 抽成独立模块有两个理由：
 *   1. 可单测 —— runner 里的 `#` 私有方法外部不可达，纯函数能直接测
 *   2. 单一事实来源 —— live 流（assistant_message）、历史回放（historyData）
 *      都要做同样的"大图换引用"，逻辑必须一致
 *
 * 规则：
 *   - 只处理 content 数组里 `{ type:"image", data, mimeType }` 块
 *   - data 长度 ≤ limit 的**原样内联**（省一次 HTTP 往返）
 *   - 超过 limit 的交给 process 回调：
 *       回调返回替换块（通常是 blobImage 引用）→ 用替换块
 *       回调返回 null → 用 fallback（占位文本），避免把大图硬塞进 wss 帧
 */

/** 一个内联图片块（pi 事件里 assistant content 的元素） */
export interface InlineImageBlock {
  type: "image";
  data: string; // base64
  mimeType?: string;
}

export interface RewriteOptions {
  /** base64 长度阈值；≤ 此值内联，> 此值交给 process */
  limit: number;
  /**
   * 处理每个超阈值图片。返回替换块；返回 null 表示无法转存（会用 fallback）。
   * 可以是同步或异步。
   */
  process: (block: InlineImageBlock) => unknown | null | Promise<unknown | null>;
  /** process 返回 null 时塞进去的占位块（默认是一条说明文本） */
  fallback?: (block: InlineImageBlock) => unknown;
}

export interface RewriteResult {
  content: unknown[];
  /** 是否发生了改写（false 表示可以跳过后续拷贝） */
  changed: boolean;
}

const DEFAULT_FALLBACK = (block: InlineImageBlock): unknown => ({
  type: "text",
  text: "（图片过大且未能转存，无法显示）",
});

export function isInlineImageBlock(
  block: unknown,
): block is InlineImageBlock {
  if (typeof block !== "object" || block === null) return false;
  const b = block as { type?: unknown; data?: unknown };
  return b.type === "image" && typeof b.data === "string";
}

/**
 * 改写 content 数组里的大图。
 *
 * @param content  原始 content 数组（assistant message.content 或历史块序列）
 * @param opts     阈值与处理回调
 * @returns        改写后的数组；无改写时返回原引用（changed=false）
 */
export async function rewriteLargeImages(
  content: unknown[],
  opts: RewriteOptions,
): Promise<RewriteResult> {
  const fallback = opts.fallback ?? DEFAULT_FALLBACK;
  let changed = false;
  const out: unknown[] = [];

  for (const block of content) {
    if (!isInlineImageBlock(block) || block.data.length <= opts.limit) {
      out.push(block);
      continue;
    }
    changed = true;
    const replacement = await opts.process(block);
    out.push(replacement ?? fallback(block));
  }

  return { content: out, changed };
}
