<script setup lang="ts">
/**
 * Markdown 渲染。
 *
 * 两个安全前提，缺一不可：
 *   1. `DOMPurify` 消毒 —— agent 输出里可能出现任意文本（含 HTML/script），
 *      直接 v-html 等于把模型输出当代码执行。
 *   2. 只允许安全标签/属性，禁用 form / iframe / on* 事件。
 *
 * 渲染本身是纯函数，放在 core 里可以单测；这里只做「文本 → HTML」的绑定。
 */
import { computed } from "vue";
import { renderMarkdown } from "../core/markdown.ts";

const props = defineProps<{ text: string }>();
const html = computed(() => renderMarkdown(props.text));
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- 内容已由 DOMPurify 消毒 -->
  <div class="md" v-html="html" />
</template>

<style scoped>
.md :deep(p) { margin: 0 0 8px; }
.md :deep(p:last-child) { margin-bottom: 0; }
.md :deep(ul), .md :deep(ol) { margin: 6px 0; padding-left: 20px; }
.md :deep(li) { margin: 2px 0; }
.md :deep(code) {
  background: var(--bg-raise);
  border-radius: 4px;
  padding: 1px 5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
}
.md :deep(pre) {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 10px;
  overflow-x: auto;
  margin: 8px 0;
}
.md :deep(pre code) { background: none; padding: 0; }
.md :deep(a) { color: var(--accent); }
.md :deep(h1), .md :deep(h2), .md :deep(h3) { font-size: 15px; margin: 12px 0 6px; }
.md :deep(blockquote) {
  margin: 8px 0;
  padding-left: 10px;
  border-left: 2px solid var(--line);
  color: var(--fg-dim);
}
.md :deep(table) { border-collapse: collapse; margin: 8px 0; font-size: 13px; }
.md :deep(th), .md :deep(td) { border: 1px solid var(--line); padding: 4px 8px; }
</style>
