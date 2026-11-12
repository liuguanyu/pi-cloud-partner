<script setup lang="ts">
/**
 * 渲染层：文本 / 用户输入 / 思考。
 * 只做展示，无业务逻辑，无网络调用。
 */
const props = defineProps<{
  kind: "text" | "user" | "thinking";
  text: string;
}>();
</script>

<template>
  <div v-if="props.kind === 'user'" class="block user">
    <div class="tag">你</div>
    <div class="body">{{ props.text }}</div>
  </div>

  <details v-else-if="props.kind === 'thinking'" class="block thinking">
    <summary>思考过程</summary>
    <div class="body">{{ props.text }}</div>
  </details>

  <div v-else class="block text">
    <div class="body">{{ props.text }}</div>
  </div>
</template>

<style scoped>
.block { margin: 10px 0; }

.user {
  background: #16202c;
  border: 1px solid #1f3145;
  border-radius: var(--radius);
  padding: 9px 12px;
}
.user .tag { font-size: 11px; color: var(--accent); margin-bottom: 3px; }

.thinking { border-left: 2px solid var(--line); padding-left: 10px; }
.thinking summary { font-size: 12px; color: var(--fg-dim); cursor: pointer; }

.body { white-space: pre-wrap; word-break: break-word; }
.thinking .body { color: var(--fg-dim); font-size: 13px; margin-top: 6px; }
</style>
