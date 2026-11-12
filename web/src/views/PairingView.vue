<script setup lang="ts">
/**
 * 配对视图：三条互斥的路径，由父组件通过 phase 决定显示哪一条。
 *   need-token        粘贴登录凭据（M1 没有 SSO）
 *   need-pair         输入 6 位配对码
 *   waiting-approval  等待 PC 上的人批准
 */
import { computed, ref } from "vue";
import type { Phase } from "../core/app.ts";
import type { PairView } from "../core/api.ts";

const props = defineProps<{
  phase: Phase;
  pairs: PairView[];
  error?: string;
  busy?: boolean;
}>();

const emit = defineEmits<{
  submitToken: [token: string];
  claim: [code: string, deviceName: string];
}>();

const tokenInput = ref("");
const codeInput = ref("");
const deviceName = ref(defaultDeviceName());

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  return "浏览器";
}

const codeReady = computed(() => codeInput.value.trim().length === 6);
</script>

<template>
  <main class="wrap">
    <section v-if="props.phase === 'need-token'">
      <h1>连接你的 pi</h1>
      <p class="muted">
        输入访问令牌。当前阶段（M1）还没有账号体系，令牌由云端
        <code class="mono">pcpd user create</code> 生成。
      </p>
      <input
        v-model="tokenInput"
        class="mono"
        placeholder="userToken"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
      />
      <button class="primary wide" :disabled="!tokenInput.trim() || props.busy" @click="emit('submitToken', tokenInput)">
        继续
      </button>
      <p v-if="props.error" class="error">{{ props.error }}</p>
    </section>

    <section v-else-if="props.phase === 'need-pair'">
      <h1>输入配对码</h1>
      <p class="muted">在运行 pi 的那台电脑上打开控制台，生成 6 位配对码。</p>
      <input
        v-model="codeInput"
        class="code mono"
        placeholder="A1B2C3"
        maxlength="6"
        autocapitalize="characters"
        autocorrect="off"
        spellcheck="false"
        @input="codeInput = codeInput.toUpperCase()"
      />
      <input v-model="deviceName" placeholder="设备名称" />
      <button class="primary wide" :disabled="!codeReady || props.busy" @click="emit('claim', codeInput, deviceName)">
        申请接管
      </button>
      <p v-if="props.error" class="error">{{ props.error }}</p>
      <p class="hint muted">配对码 120 秒有效，一次性。</p>
    </section>

    <section v-else-if="props.phase === 'waiting-approval'">
      <h1>等待确认</h1>
      <p class="muted">
        申请已送达。请在那台电脑上点击「允许」——<strong>批准只能在电脑端完成</strong>，云端无权代替。
      </p>
      <div class="pending">
        <span class="spinner" />
        <span>等待批准…</span>
      </div>
      <p v-if="props.error" class="error">{{ props.error }}</p>
    </section>
  </main>
</template>

<style scoped>
.wrap {
  padding: 32px 20px calc(24px + env(safe-area-inset-bottom));
  max-width: 460px;
  margin: 0 auto;
}
h1 { font-size: 22px; margin: 0 0 8px; }
p { margin: 0 0 18px; font-size: 13px; }
code { background: var(--bg-raise); padding: 1px 5px; border-radius: 4px; }
input { margin-bottom: 12px; }
.code {
  font-size: 24px;
  letter-spacing: 0.35em;
  text-align: center;
  padding: 14px;
}
.wide { width: 100%; }
.error { color: var(--err); font-size: 13px; margin-top: 12px; }
.hint { font-size: 12px; margin-top: 12px; }
.pending {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-soft);
  font-size: 14px;
}
.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--line);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
