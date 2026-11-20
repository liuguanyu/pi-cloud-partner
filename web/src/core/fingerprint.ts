/**
 * 浏览器环境指纹：用于"同一台手机重配对时免人工批准"。
 *
 * 关键设计：**不依赖任何存储**（localStorage 会被 iOS 清掉，依赖它就没意义了）。
 * 每次打开页面都能重新算出同一个值。
 *
 * 组成：UA + 语言 + 时区 + 平台 + 屏幕分辨率 + 像素比 + 语言数量。
 * 熵有限（同型号同系统的 iPhone 会撞），但配合威胁模型够用：
 *   攻击者要绕过人工批准，必须同时拿到「本机配对码（120s、一次性）」
 *   和「指纹匹配」。配对码本来就是门，指纹只是省去"回 Mac 点一下"。
 * 发送前 SHA-256，云端不存明文。
 */

export async function browserFingerprint(): Promise<string> {
  const parts = [
    navigator.userAgent,
    navigator.language,
    (navigator.languages ?? []).join(","),
    safeTimeZone(),
    String(navigator.platform ?? ""),
    `${screen.width}x${screen.height}@${window.devicePixelRatio ?? 1}`,
  ];
  const raw = parts.join("|");
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    // crypto.subtle 需要安全上下文；降级用简单 hash（仍是环境指纹）
    let h = 0;
    for (let i = 0; i < raw.length; i += 1) h = (Math.imul(h, 31) + raw.charCodeAt(i)) | 0;
    return `fnv${(h >>> 0).toString(16)}`;
  }
}

function safeTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}
