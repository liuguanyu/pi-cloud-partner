<script setup lang="ts">
import PwaHint from "../components/PwaHint.vue";
/**
 * 任务列表 + 新建任务。
 *
 * 语义约定（protocol/control.md §5）：
 *   列表页的输入框 = **新建任务**；要继续某个任务必须点进去在详情页输入（= steer）。
 *   这是两件不同的事，UI 上必须能区分，否则用户以为在追问、实际开了新任务。
 */
import { computed, ref, watch } from "vue";
import type { Capacity } from "@wire";
import type { TaskView } from "../core/store.ts";

interface DirEntry {
  path: string;
  name: string;
  depth: number;
  isGit: boolean;
}

const props = defineProps<{
  tasks: TaskView[];
  workspaces: string[];
  /** 白名单下扫描出的候选目录（git 仓库排在前面） */
  dirs: DirEntry[];
  capacity?: Capacity;
  bridgeOnline: boolean;
  /** 首次同步完成前不要断言"离线" */
  primed: boolean;
  busy?: boolean;
  error?: string;
}>();

interface BlobRef {
  blobId: string;
  kind?: string;
  name?: string;
  mimeType?: string;
}

const emit = defineEmits<{
  create: [input: { prompt: string; workspace: string; isolation: "shared" | "worktree"; blobs: BlobRef[] }];
  open: [taskId: string];
  upload: [files: FileList];
}>();

const prompt = ref("");
const workspace = ref(props.workspaces[0] ?? "");
const isolation = ref<"shared" | "worktree">("shared");
const showComposer = ref(false);
const manualMode = ref(false);
/** 已上传成功的附件 */
const attachments = ref<Array<BlobRef & { name?: string }>>([]);
const uploading = ref(false);
const uploadError = ref("");
const fileInput = ref<HTMLInputElement | null>(null);

/** 根目录在前，git 仓库次之，其余按名字（后端已排好序，这里只做缩进展示） */
const selectableDirs = computed<DirEntry[]>(() => {
  if (props.dirs.length > 0) return props.dirs;
  // 兜底：只有白名单根目录
  return props.workspaces.map((path) => ({
    path,
    name: path.split("/").filter(Boolean).pop() ?? path,
    depth: 0,
    isGit: false,
  }));
});

function dirLabel(dir: DirEntry): string {
  const indent = "\u00a0\u00a0".repeat(dir.depth);
  const mark = dir.isGit ? "● " : "";
  return `${indent}${mark}${dir.name}${dir.depth === 0 ? "  （根目录）" : ""}`;
}

// workspace 的默认值必须跟随 props 回填：组件挂载时白名单可能还没拉回来，
// 只初始化一次会导致「下拉有选项、但内部值仍是空」从而永远禁用提交。
watch(workspace, () => {
  // 手动输入的内容会写回同一个变量，这里不做额外处理
});

watch(
  () => props.workspaces,
  (list) => {
    if (!workspace.value && list.length > 0) workspace.value = list[0] as string;
    if (workspace.value && !list.includes(workspace.value)) workspace.value = list[0] ?? "";
  },
  { immediate: true, deep: false },
);

const canCreate = computed(
  () =>
    props.primed &&
    props.bridgeOnline &&
    prompt.value.trim().length > 0 &&
    workspace.value.length > 0 &&
    !uploading.value,
);

function pickFiles(): void {
  fileInput.value?.click();
}

function onFilesPicked(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = input.files;
  if (!files || files.length === 0) return;
  uploadError.value = "";
  uploading.value = true;
  emit("upload", files);
  // 清空 input，否则选同一个文件不会再次触发 change
  input.value = "";
}

/** App 在收到上传完成回调后调用（见 App.vue 的 handleUpload） */
function addAttachment(blob: BlobRef): void {
  attachments.value = [...attachments.value, blob];
}

function removeAttachment(blobId: string): void {
  attachments.value = attachments.value.filter((item) => item.blobId !== blobId);
}

defineExpose({ addAttachment, setUploading: (v: boolean) => (uploading.value = v), setUploadError: (msg: string) => (uploadError.value = msg) });

const capacityText = computed(() => {
  const cap = props.capacity;
  if (!cap) return "";
  const queued = cap.queued ? ` · 排队 ${cap.queued}` : "";
  return `${cap.running}/${cap.maxRunning} 运行${queued}`;
});

function submit(): void {
  if (!canCreate.value) return;
  emit("create", {
    prompt: prompt.value.trim(),
    workspace: workspace.value,
    isolation: isolation.value,
    blobs: attachments.value.map(({ blobId, kind, name, mimeType }) => ({ blobId, kind, name, mimeType })),
  });
  prompt.value = "";
  attachments.value = [];
  showComposer.value = false;
}

function shortPath(path: string): string {
  if (!path) return "";
  const parts = path.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

function statusLabel(status: string): string {
  return (
    {
      queued: "排队中",
      running: "运行中",
      awaiting_approval: "待审批",
      settled: "已完成",
      failed: "失败",
      cancelled: "已取消",
      interrupted: "已中断（状态未同步）",
      stale: "状态未知",
    } as Record<string, string>
  )[status] ?? status;
}
</script>

<template>
  <main class="wrap">
    <div class="meta">
      <span class="dot" :data-on="props.bridgeOnline ? 'true' : 'false'" />
      <span class="muted">
        {{ !props.primed ? "正在同步…" : props.bridgeOnline ? "本机在线" : "本机离线" }}
      </span>
      <span v-if="capacityText" class="muted">· {{ capacityText }}</span>
    </div>

    <PwaHint />

    <p v-if="props.primed && !props.bridgeOnline" class="notice">
      那台电脑当前不在线。可以查看历史任务，但无法下发新任务。
    </p>

    <ul class="list">
      <li v-for="task in props.tasks" :key="task.taskId" @click="emit('open', task.taskId)">
        <div class="row">
          <span class="title">{{ task.title }}</span>
          <span class="pill" :data-status="task.status">{{ statusLabel(task.status) }}</span>
        </div>
        <div class="sub muted">
          <span v-if="task.workspace">{{ shortPath(task.workspace) }}</span>
          <span v-if="task.holdReason === 'terminal_busy'" class="held">终端正在使用该目录，已排队</span>
          <span v-else-if="task.lastLine" class="line">{{ task.lastLine }}</span>
        </div>
      </li>
      <li v-if="props.tasks.length === 0" class="empty muted">还没有任务。在下面输入你的第一个需求。</li>
    </ul>

    <div v-if="showComposer" class="composer">
      <label class="field">
        <span class="label muted">
          工作目录
          <span v-if="props.dirs.length === 0" class="warn-inline">（尚未同步到目录列表，可手动输入）</span>
        </span>
        <select v-model="workspace">
          <option v-for="dir in selectableDirs" :key="dir.path" :value="dir.path">
            {{ dirLabel(dir) }}
          </option>
        </select>
        <input
          v-if="manualMode"
          v-model="workspace"
          class="mono manual"
          placeholder="/绝对路径（需在白名单内）"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
        />
        <button v-if="props.dirs.length > 0" class="link" @click="manualMode = !manualMode">
          {{ manualMode ? "从列表选择" : "手动输入路径" }}
        </button>
      </label>
      <label class="check">
        <input v-model="isolation" type="checkbox" :true-value="'worktree'" :false-value="'shared'" />
        <span>worktree 隔离（同一仓库并行跑时用）</span>
      </label>
      <textarea v-model="prompt" rows="3" placeholder="要它做什么？例：修一下登录接口的 500" />

      <div v-if="attachments.length > 0 || uploading" class="attach-list">
        <span v-for="item in attachments" :key="item.blobId" class="chip">
          {{ item.kind === "image" ? "🖼" : "📄" }} {{ item.name || item.blobId.slice(0, 8) }}
          <button class="chip-x" @click="removeAttachment(item.blobId)">×</button>
        </span>
        <span v-if="uploading" class="chip muted">上传中…</span>
      </div>
      <p v-if="uploadError" class="error small">{{ uploadError }}</p>
      <div class="actions">
        <button :disabled="props.busy || uploading" @click="showComposer = false">取消</button>
        <button :disabled="uploading" @click="pickFiles">📎 附件</button>
        <button class="primary" :disabled="!canCreate || props.busy" @click="submit">新任务</button>
      </div>
      <input ref="fileInput" type="file" multiple hidden @change="onFilesPicked" />
      <p v-if="props.error" class="error">{{ props.error }}</p>
    </div>

    <button v-else class="fab primary" :disabled="!props.bridgeOnline" @click="showComposer = true">
      ＋ 新任务
    </button>
  </main>
</template>

<style scoped>
.wrap { padding: 14px 14px calc(90px + env(safe-area-inset-bottom)); max-width: 620px; margin: 0 auto; }

.meta { display: flex; align-items: center; gap: 7px; font-size: 12px; padding: 4px 2px 10px; }

.notice {
  background: #2a2312;
  border: 1px solid #4a3a13;
  color: #d29922;
  border-radius: var(--radius);
  padding: 10px 12px;
  font-size: 13px;
  margin: 0 0 12px;
}

.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.list li {
  background: var(--bg-soft);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 12px;
  cursor: pointer;
}
.list li:active { background: var(--bg-raise); }

.row { display: flex; align-items: center; gap: 10px; }
.title { font-size: 14px; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { display: flex; gap: 8px; font-size: 12px; margin-top: 5px; }
.sub .line { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub .held { color: var(--warn); }

.empty { text-align: center; padding: 32px 12px; font-size: 13px; }

.fab {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(18px + env(safe-area-inset-bottom));
  padding: 13px 26px;
  border-radius: 999px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
}

.composer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--bg-soft);
  border-top: 1px solid var(--line);
  border-radius: 16px 16px 0 0;
  padding: 16px 14px calc(16px + env(safe-area-inset-bottom));
  display: grid;
  gap: 10px;
  z-index: 40;
}
.field .label { font-size: 11px; display: block; margin-bottom: 4px; }
.field .manual { margin-top: 6px; font-size: 13px; }
.field .link {
  background: none;
  border: none;
  padding: 0;
  margin-top: 6px;
  color: var(--accent);
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}
.warn-inline { color: var(--warn); }
.check { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--fg-dim); }
.check input { width: auto; }
.actions { display: flex; gap: 10px; }
.actions button { flex: 1; }
.actions button:nth-child(2) { flex: 0 0 auto; }

.attach-list { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip-x { background: none; border: none; padding: 0 0 0 2px; color: var(--fg-dim); cursor: pointer; }
.error.small { font-size: 12px; }
.error { color: var(--err); font-size: 12px; }
</style>
