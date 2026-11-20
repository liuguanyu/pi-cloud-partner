<script setup lang="ts">
/**
 * 「添加到主屏幕」引导。
 *
 * 背景：用相机扫码器进入的页面，iOS 切后台回收 Safari 后就找不回来
 * （不存在"属于扫码器的网页"这个实体）。日常入口必须是主屏幕图标：
 * 独立 PWA、不随 Safari 回收、存储生命周期也更稳定。
 *
 * 两种平台：
 *   iOS Safari  —— 没有 beforeinstallprompt，只能文案引导（分享 → 添加到主屏幕）
 *   Android 等  —— 捕获 beforeinstallprompt，直接给"安装"按钮
 *
 * 只在非 standalone 模式显示；点过"知道了"就不再打扰（localStorage 标记）。
 */
import { onMounted, onUnmounted, ref } from "vue";

const DISMISS_KEY = "pcp.pwa-hint.dismissed.v1";

const show = ref(false);
const isIOS =
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

let deferredPrompt: (Event & { prompt: () => void; userChoice: Promise<{ outcome: string }> }) | null =
  null;

const isStandalone =
  (navigator as { standalone?: boolean }).standalone === true ||
  window.matchMedia("(display-mode: standalone)").matches;

function onBeforeInstallPrompt(e: Event): void {
  e.preventDefault();
  deferredPrompt = e as typeof deferredPrompt;
  if (!isStandalone && !dismissed()) show.value = true;
}

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function dismiss(): void {
  show.value = false;
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* ignore */
  }
}

function install(): void {
  if (!deferredPrompt) return;
  void deferredPrompt.prompt();
  void deferredPrompt.userChoice.finally(() => {
    deferredPrompt = null;
    dismiss();
  });
}

onMounted(() => {
  if (isStandalone) return;
  if (isIOS) {
    if (!dismissed()) show.value = true;
    return;
  }
  window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
});

onUnmounted(() => {
  window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
});
</script>

<template>
  <div v-if="show" class="hint">
    <div class="body">
      <strong>添加「pi」到主屏幕</strong>
      <p v-if="isIOS">
        用相机扫码进来的页面，切后台就会被系统回收、找不到回来。
        点 Safari 底部
        <b>分享</b>
        <svg viewBox="0 0 16 16" class="ico"><path fill="currentColor" d="M8 1.5l4 4h-2.5V11h-3V5.5H4l4-4zM3.5 6.5h1.7v7h5.6v-7h1.7v8.2H3.5V6.5z"/></svg>
        → <b>添加到主屏幕</b>，以后从桌面图标进入就不会丢。
      </p>
      <p v-else>
        主屏幕图标是独立应用，不受浏览器回收影响，建议安装。
      </p>
    </div>
    <div class="actions">
      <button v-if="!isIOS && deferredPrompt" class="primary" @click="install">安装</button>
      <button class="ghost" @click="dismiss">知道了</button>
    </div>
  </div>
</template>

<style scoped>
.hint {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin: 10px 12px 0;
  padding: 10px 12px;
  border: 1px solid #2b4a6f;
  border-radius: var(--radius);
  background: #0e1a29;
}
.body { flex: 1; min-width: 0; }
.body strong { font-size: 13px; color: #9ecbff; }
.body p {
  margin: 5px 0 0;
  font-size: 12px;
  line-height: 1.65;
  color: var(--fg-dim);
}
.ico { width: 13px; height: 13px; vertical-align: -2px; color: #9ecbff; }
.actions { display: flex; flex-direction: column; gap: 6px; flex: 0 0 auto; }
.actions button {
  border-radius: 8px;
  font-size: 12px;
  padding: 5px 12px;
  cursor: pointer;
  border: 1px solid var(--line);
  background: none;
  color: var(--fg-dim);
}
.actions .primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
</style>
