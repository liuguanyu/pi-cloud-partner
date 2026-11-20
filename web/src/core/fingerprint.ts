/**
 * 浏览器环境指纹：用于"同一台手机重配对时免人工批准"。
 *
 * 关键设计（两条铁律，都踩过坑）：
 *
 * 1. **不依赖任何存储**（localStorage 会被 iOS 清掉，依赖它就没意义了）。
 *    每次打开页面都能重新算出同一个值。
 *
 * 2. **不含 navigator.userAgent**（2026-11-20 实测踩坑）。
 *    iOS 上同一台手机在不同容器里 UA 不同：
 *      微信内置浏览器  → UA 带 MicroMessenger
 *      Safari / 主屏幕 PWA 容器 → 纯 Safari UA
 *    微信里配对、图标容器里重连时，带 UA 的指纹永远匹配不上，自动批准
 *    形同虚设。所以指纹只取**设备级**特征——跨容器稳定的那部分。
 *
 * 组成：语言 + 时区 + 平台 + 屏幕分辨率@像素比。
 * 熵有限（同型号同系统的 iPhone 会撞），但配合威胁模型够用：
 *   攻击者要绕过人工批准，必须同时拿到「本机配对码（120s、一次性）」
 *   和「指纹匹配」。配对码本来就是门，指纹只是省去"回 Mac 点一下"。
 * 发送前 SHA-256，云端不存明文。
 */

export async function browserFingerprint(): Promise<string> {
  const parts = [
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
