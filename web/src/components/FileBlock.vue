<script setup lang="ts">
/**
 * agent 用 pcp_send 发来的文件（非图片）：一个可下载的卡片。
 * 下载走签名 URL —— <a download> 同样带不了 Authorization。
 */
import { ref } from "vue";
import { useBridge } from "../composables/useBridge";
import type { Block } from "../core/store";

const props = defineProps<{ block: Extract<Block, { kind: "file" }> }>();
const { actions } = useBridge();
const url = ref("");
const failed = ref(false);
const loading = ref(true);

async function resolve(force = false): Promise<void> {
  loading.value = true;
  failed.value = false;
  try {
    url.value = await actions.resolveBlobUrl(props.block.blobId, force);
  } catch {
    failed.value = true;
  } finally {
    loading.value = false;
  }
}

function download(): void {
  if (!url.value) return;
  const a = document.createElement("a");
  a.href = url.value;
  a.download = props.block.name || "download";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

resolve();

function fmtBytes(n?: number): string {
  if (!n) return "";
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1048576).toFixed(1)}MB`;
}
</script>

<template>
  <div class="fileblock">
    <span class="icon">📄</span>
    <div class="meta">
      <div class="name">{{ props.block.name }}</div>
      <div class="sub muted">
        {{ fmtBytes(props.block.bytes) }}
        <template v-if="props.block.note"> · {{ props.block.note }}</template>
      </div>
    </div>
    <button v-if="url" class="dl" @click="download">下载</button>
    <button v-else-if="failed" class="dl" @click="resolve(true)">重试</button>
    <span v-else class="dl muted">…</span>
  </div>
</template>

<style scoped>
.fileblock {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 0;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg);
}
.icon { font-size: 20px; }
.meta { flex: 1; min-width: 0; }
.name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sub { font-size: 11px; margin-top: 1px; }
.dl {
  flex: 0 0 auto;
  background: none;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 5px 10px;
  font-size: 12px;
  color: var(--accent);
  cursor: pointer;
}
.dl:hover { border-color: var(--accent); }
.dl.muted { color: var(--fg-dim); }
</style>
