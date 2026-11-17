<script setup lang="ts">
/**
 * 渲染层：图片。
 *
 * 两种来源：
 *   image      —— 内联 base64（小图，随事件直接到了）
 *   blobImage  —— blob 引用（大图，bridge 已转存）。<img> 带不了 Authorization，
 *                 必须先换签名 URL；失败/过期时给出可重试的提示。
 */
import { computed, onMounted, ref } from "vue";
import { useBridge } from "../composables/useBridge";

const props = defineProps<{
  kind: "image" | "blobImage";
  data?: string;
  mimeType?: string;
  blobId?: string;
  name?: string;
}>();

const { actions } = useBridge();
const signedUrl = ref("");
const loading = ref(props.kind === "blobImage");
const failed = ref(false);

const inlineSrc = computed(
  () =>
    props.kind === "image" && props.data
      ? `data:${props.mimeType || "image/png"};base64,${props.data}`
      : "",
);
const src = computed(() => (props.kind === "image" ? inlineSrc.value : signedUrl.value));

async function resolve(force = false): Promise<void> {
  if (props.kind !== "blobImage" || !props.blobId) return;
  loading.value = true;
  failed.value = false;
  try {
    signedUrl.value = await actions.resolveBlobUrl(props.blobId, force);
  } catch {
    failed.value = true;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void resolve();
});

function retry(): void {
  // <img onerror> 多半是签名过期：绕过本地缓存强制换一张新的
  signedUrl.value = "";
  void resolve(true);
}
</script>

<template>
  <div class="imgblock">
    <img v-if="src" :src="src" :alt="props.name || '图片'" loading="lazy" @error="retry" />
    <div v-else-if="loading" class="placeholder">加载图片中…</div>
    <button v-else-if="failed" class="placeholder retry" @click="retry">
      图片加载失败，点击重试
    </button>
    <div v-else class="placeholder">（图片）</div>
  </div>
</template>

<style scoped>
.imgblock { margin: 10px 0; }
img {
  max-width: 100%;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  display: block;
}
.placeholder {
  font-size: 12px;
  color: var(--fg-dim);
  padding: 14px;
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  text-align: center;
}
button.placeholder { background: none; cursor: pointer; }
button.placeholder:hover { color: var(--accent); border-color: var(--accent); }
</style>
