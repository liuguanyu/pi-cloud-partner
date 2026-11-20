<script setup lang="ts">
/**
 * 桌面控制台（设备端）。
 *
 * 只由 **本地 bridge**（127.0.0.1）提供，因为这个页面要调本地 API 去申请配对码
 * 和批准 —— deviceToken 始终在 bridge 进程里，页面拿不到它。
 *
 * 手机不需要访问这里：二维码里编的是云端地址，扫码后直接落到云端配对页。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import qrcode from "qrcode-generator";

interface PendingClaim {
  pairId: string;
  status: string;
  user?: { displayName?: string };
  device?: { name?: string };
  /** 来源 IP：让人在批准前能判断是不是自己那台手机 */
  claimIp?: string;
}

interface LocalStatus {
  online?: boolean;
  device?: string;
  server?: string;
  pairs?: number;
  capacity?: { running: number; maxRunning: number; liveChildren: number; queued: number };
}

const status = ref<LocalStatus>({});
const code = ref("");
const claimUrl = ref("");
const expiresAt = ref(0);
const pending = ref<PendingClaim | null>(null);
const active = ref<PendingClaim | null>(null);
const error = ref("");
const busy = ref(false);
const copied = ref(false);
/**
 * 生成配对码那一刻，服务器上已有的 active pair。
 *
 * 用途：区分"配对刚完成"与"早就存在的旧 active"。
 * 后者不能清掉码（换设备时旧 active 会一直在，直到新的一次批准顶替它）。
 */
const activeAtStart = ref<string>("");
/** 配对刚成功（用于给一次明确的反馈，而不是静默跳转） */
const justPaired = ref(false);
const now = ref(Date.now());

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;

const remaining = computed(() => Math.max(0, Math.round((expiresAt.value - now.value) / 1000)));
const qr = computed(() => (claimUrl.value ? renderQr(claimUrl.value) : ""));

function renderQr(text: string): string {
  const qrCode = qrcode(0, "M");
  qrCode.addData(text);
  qrCode.make();
  return qrCode.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) {
    const err = payload as { error?: string; message?: string } | undefined;
    throw new Error(err?.message ?? err?.error ?? `HTTP ${response.status}`);
  }
  return payload as T;
}

async function refreshStatus(): Promise<void> {
  try {
    status.value = await call<LocalStatus>("/api/local/status");
  } catch {
    /* 忽略：可能 bridge 正在重启 */
  }
}

async function startPairing(): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    const created = await call<{ code: string; expiresAt: number; claimUrl: string }>("/api/local/pair/start", {
      method: "POST",
      body: "{}",
    });
    code.value = created.code;
    claimUrl.value = created.claimUrl;
    expiresAt.value = created.expiresAt;
    pending.value = null;
    justPaired.value = false;
    // 记下"此刻已存在的 active pair"，poll 里据此判断本次配对是否完成
    try {
      const snap = await call<{ active: PendingClaim | null }>("/api/local/pair/pending");
      activeAtStart.value = snap.active?.pairId ?? "";
      active.value = snap.active;
    } catch {
      activeAtStart.value = active.value?.pairId ?? "";
    }
    schedulePoll();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

function schedulePoll(delayMs = 1500): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => void poll(), delayMs);
}

async function poll(): Promise<void> {
  try {
    const result = await call<{ pending: PendingClaim | null; active: PendingClaim | null }>(
      "/api/local/pair/pending",
    );
    pending.value = result.pending;
    active.value = result.active;

    // 配对完成：active 变成了与"生成码时"不同的 pairId。
    // 这里必须清码，否则模板会一直停在扫码卡片（v-else-if="code" 优先于
    // "已配对"），用户看到的就是"扫完了 Mac 还停在扫码页"。
    // 注意：自动批准（指纹命中）时 pending 一直是空的，只有 active 变化可依赖。
    if (code.value && result.active && result.active.pairId !== activeAtStart.value) {
      clearCode();
      justPaired.value = true;
      setTimeout(() => (justPaired.value = false), 4000);
    }

    // 只在**码自己过期**时清掉它。
    // 不能因为"服务器上还有一个旧的 active pair"就清——
    // 换设备时那个 active 会一直存在，直到新的一次批准把它顶替掉。
    if (code.value && Date.now() > expiresAt.value + 3000) {
      clearCode();
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
  // 正在配对（有码或有待批）就快轮询，否则慢轮询
  schedulePoll(code.value !== "" || pending.value ? 1500 : 5000);
}

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(claimUrl.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    error.value = "复制失败，请手动选中链接";
  }
}

function clearCode(): void {
  code.value = "";
  claimUrl.value = "";
  expiresAt.value = 0;
}

async function decide(decision: "approve" | "reject"): Promise<void> {
  if (!pending.value) return;
  busy.value = true;
  error.value = "";
  try {
    await call("/api/local/pair/decide", {
      method: "POST",
      body: JSON.stringify({ pairId: pending.value.pairId, decision, takeover: true }),
    });
    pending.value = null;
    if (decision === "approve") clearCode();
    await poll();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void refreshStatus();
  void poll();
  clockTimer = setInterval(() => {
    now.value = Date.now();
  }, 500);
});

onUnmounted(() => {
  if (pollTimer) clearTimeout(pollTimer);
  if (clockTimer) clearInterval(clockTimer);
});
</script>

<template>
  <main class="wrap">
    <header>
      <div class="row">
        <span class="dot" :data-on="status.online ? 'true' : 'false'" />
        <strong>{{ status.device || "bridge" }}</strong>
        <span class="muted">{{ status.online ? "已连云" : "未连云" }}</span>
      </div>
      <div class="meta muted">
        <span v-if="status.capacity">
          {{ status.capacity.running }}/{{ status.capacity.maxRunning }} 运行 ·
          {{ status.capacity.liveChildren }} 个子进程
          <template v-if="status.capacity.queued"> · 排队 {{ status.capacity.queued }}</template>
        </span>
        <span v-if="status.server" class="mono">{{ status.server }}</span>
      </div>
    </header>

    <section v-if="pending" class="card attention">
      <h2>有手机请求接管</h2>
      <p>有一台设备请求控制这台机器。</p>
      <p v-if="pending.claimIp" class="muted small">来源 IP：<span class="mono">{{ pending.claimIp }}</span></p>
      <p class="muted small mono">{{ pending.pairId }}</p>
      <div class="actions">
        <button class="danger" :disabled="busy" @click="decide('reject')">拒绝</button>
        <button class="primary" :disabled="busy" @click="decide('approve')">允许</button>
      </div>
      <p class="hint muted">批准只能在这里发生——云端无权批准，手机也不能自己批准。</p>
    </section>

    <section v-else-if="code" class="card">
      <h2>用手机扫码</h2>
      <div class="qr" v-html="qr" />
      <p class="code mono">{{ code }}</p>
      <p class="muted small">
        用手机相机或<b>微信「扫一扫」</b>都可以。剩余 {{ remaining }} 秒。
      </p>
      <div class="linkrow">
        <input class="mono" readonly :value="claimUrl" @focus="(e) => (e.target as HTMLInputElement).select()" />
        <button @click="copyLink">{{ copied ? "已复制" : "复制" }}</button>
      </div>
      <p class="muted small">
        微信里没有地址栏，下次进入需要重新扫码；想省事可以用 Safari 打开一次后「添加到主屏幕」。
      </p>

    </section>

    <section v-else-if="active" class="card ok">
      <p v-if="justPaired" class="paired-flash">✓ 配对成功</p>
      <h2>已配对</h2>
      <p class="muted">
        一台手机正在控制这台机器<template v-if="active.claimIp">（来源 IP {{ active.claimIp }}）</template>。
      </p>
      <p class="muted small">手机上打开 {{ status.server }} 即可下发任务。</p>
      <button :disabled="busy" @click="startPairing">换一台手机配对</button>
    </section>

    <section v-else class="card">
      <h2>配对一台手机</h2>
      <p class="muted">
        点击后生成一次性配对码（120 秒有效）。扫码的链接指向云端，手机无需访问这台电脑。
      </p>
      <button class="primary wide" :disabled="busy" @click="startPairing">生成配对码</button>
    </section>

    <p v-if="error" class="error">{{ error }}</p>
  </main>
</template>

<style scoped>
.paired-flash {
  color: #3fb950;
  font-size: 13px;
  margin: 0 0 8px;
  animation: fade-in .25s ease-out;
}
@keyframes fade-in {
  from { opacity: 0; transform: translateY(-3px); }
  to { opacity: 1; transform: none; }
}

.wrap { max-width: 460px; margin: 0 auto; padding: 22px 18px 40px; }

header { margin-bottom: 18px; }
.row { display: flex; align-items: center; gap: 8px; font-size: 15px; }
.meta { display: flex; flex-direction: column; gap: 3px; font-size: 12px; margin-top: 6px; }
.meta .mono { font-size: 11px; opacity: 0.7; }

.card {
  background: var(--bg-soft);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 18px 16px;
}
.card.ok { border-color: #1c3b24; background: #101f16; }
.card.attention { border-color: #5a3a17; background: #1f1708; }

h2 { font-size: 16px; margin: 0 0 8px; }
p { margin: 0 0 10px; font-size: 13px; }
.small { font-size: 12px; }

.qr { display: flex; justify-content: center; padding: 6px 0 10px; }
.qr :deep(svg) { width: 190px; height: 190px; background: #fff; border-radius: 8px; padding: 8px; }

.code {
  text-align: center;
  font-size: 28px;
  letter-spacing: 0.3em;
  margin: 4px 0 12px;
}

.actions { display: flex; gap: 10px; margin: 12px 0 8px; }
.actions button { flex: 1; }
.wide { width: 100%; margin-top: 6px; }

.hint { font-size: 11px; text-align: center; margin-top: 10px; }
.linkrow { display: flex; gap: 8px; margin: 10px 0; }
.linkrow input { flex: 1; font-size: 12px; padding: 8px 10px; }
.linkrow button { flex: 0 0 auto; padding: 8px 14px; font-size: 13px; }
.error { color: var(--err); font-size: 13px; margin-top: 14px; }
code { background: var(--bg-raise); padding: 1px 5px; border-radius: 4px; }
</style>
