<script setup lang="ts">
/**
 * 工具调用卡片。折叠态只显示「工具名 + 状态」，展开看参数与结果。
 * 纯展示，不决定审批（审批是 ApprovalSheet 的职责）。
 */
import { computed } from "vue";

const props = defineProps<{
  block: {
    toolCallId: string;
    toolName: string;
    argsText: string;
    resultText?: string;
    isError?: boolean;
    durationMs?: number;
    done: boolean;
  };
}>();

const label = computed(() => props.block.toolName || "tool");
const state = computed(() => {
  if (!props.block.done) return "运行中";
  if (props.block.isError) return "失败";
  return props.block.durationMs !== undefined ? `${props.block.durationMs}ms` : "完成";
});
</script>

<template>
  <details class="tool" :data-error="props.block.isError ? 'true' : 'false'">
    <summary>
      <span class="name mono">{{ label }}</span>
      <span class="state">{{ state }}</span>
    </summary>
    <div class="section">
      <div class="label">参数</div>
      <pre class="mono">{{ props.block.argsText || "(空)" }}</pre>
    </div>
    <div v-if="props.block.resultText" class="section">
      <div class="label">结果</div>
      <pre class="mono">{{ props.block.resultText }}</pre>
    </div>
  </details>
</template>

<style scoped>
.tool {
  margin: 8px 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-soft);
  overflow: hidden;
}
.tool[data-error="true"] { border-color: #4a2224; }

summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  cursor: pointer;
  font-size: 13px;
  list-style: none;
}
summary::marker { content: ""; }
.name { color: var(--accent); }
.state { margin-left: auto; color: var(--fg-dim); font-size: 12px; }
.tool[data-error="true"] .state { color: var(--err); }

.section { padding: 0 12px 10px; }
.label { font-size: 11px; color: var(--fg-dim); margin: 4px 0; }
pre {
  margin: 0;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--fg-dim);
  max-height: 220px;
  overflow: auto;
}
</style>
