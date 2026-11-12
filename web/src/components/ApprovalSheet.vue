<script setup lang="ts">
/**
 * 审批弹层。
 *
 * 只负责「把用户的决定表达出去」，不做任何判断：
 * 默认动作是**拒绝**（fail-safe），超时由 pi 侧处理并自动拒绝。
 */
import { computed, ref } from "vue";
import type { UiRequestPayload } from "@wire";

const props = defineProps<{
  approval: UiRequestPayload & { taskId: string };
  busy?: boolean;
}>();

const emit = defineEmits<{
  decide: [decision: "approve" | "deny" | { value: unknown }];
}>();

const selectValue = ref<string>("");

const isConfirm = computed(() => props.approval.method === "confirm");
const isSelect = computed(() => props.approval.method === "select");
const options = computed(() => props.approval.options ?? []);
</script>

<template>
  <div class="scrim">
    <div class="sheet">
      <header>
        <div class="kind">远程审批</div>
        <h2>{{ props.approval.title || props.approval.method }}</h2>
        <div v-if="props.approval.taskTitle" class="task muted">任务：{{ props.approval.taskTitle }}</div>
      </header>

      <pre class="message mono">{{ props.approval.message || "(无参数)" }}</pre>

      <div v-if="isSelect" class="options">
        <label v-for="opt in options" :key="opt" class="option">
          <input v-model="selectValue" type="radio" :value="opt" name="approval-option" />
          <span>{{ opt }}</span>
        </label>
      </div>

      <footer>
        <template v-if="isConfirm">
          <button class="danger" :disabled="props.busy" @click="emit('decide', 'deny')">拒绝</button>
          <button class="primary" :disabled="props.busy" @click="emit('decide', 'approve')">允许</button>
        </template>
        <template v-else-if="isSelect">
          <button class="danger" :disabled="props.busy" @click="emit('decide', { value: undefined })">取消</button>
          <button
            class="primary"
            :disabled="props.busy || !selectValue"
            @click="emit('decide', { value: selectValue })"
          >
            选择
          </button>
        </template>
        <template v-else>
          <button class="danger" :disabled="props.busy" @click="emit('decide', 'deny')">取消</button>
        </template>
      </footer>

      <p class="hint muted">默认拒绝。90 秒无响应会自动拒绝，任务不会永久挂起。</p>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(2, 6, 12, 0.72);
  display: flex;
  align-items: flex-end;
  z-index: 50;
  backdrop-filter: blur(2px);
}

.sheet {
  width: 100%;
  background: var(--bg-soft);
  border-top: 1px solid var(--line);
  border-radius: 16px 16px 0 0;
  padding: 18px 16px calc(18px + env(safe-area-inset-bottom));
  max-height: 82vh;
  overflow: auto;
}

.kind { font-size: 11px; color: #f0883e; letter-spacing: 0.08em; }
h2 { font-size: 16px; margin: 6px 0 2px; }
.task { font-size: 12px; margin-bottom: 10px; }

.message {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 10px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 30vh;
  overflow: auto;
  color: var(--fg-dim);
}

.options { margin-top: 10px; display: grid; gap: 6px; }
.option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  font-size: 14px;
}
.option input { width: auto; }

footer { display: flex; gap: 10px; margin-top: 16px; }
footer button { flex: 1; }

.hint { font-size: 11px; margin: 10px 0 0; text-align: center; }
</style>
