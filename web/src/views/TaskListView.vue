<script setup lang="ts">
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

const props = defineProps<{
  tasks: TaskView[];
  workspaces: string[];
  capacity?: Capacity;
  bridgeOnline: boolean;
  /** 首次同步完成前不要断言"离线" */
  primed: boolean;
  busy?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  create: [input: { prompt: string; workspace: string; isolation: "shared" | "worktree" }];
  open: [taskId: string];
}>();

const prompt = ref("");
const workspace = ref(props.workspaces[0] ?? "");
const isolation = ref<"shared" | "worktree">("shared");
const showComposer = ref(false);

// workspace 的默认值必须跟随 props 回填：组件挂载时白名单可能还没拉回来，
// 只初始化一次会导致「下拉有选项、但内部值仍是空」从而永远禁用提交。
watch(
  () => props.workspaces,
  (list) => {
    if (!workspace.value && list.length > 0) workspace.value = list[0] as string;
    if (workspace.value && !list.includes(workspace.value)) workspace.value = list[0] ?? "";
  },
  { immediate: true, deep: false },
);

const canCreate = computed(
  () => props.primed && props.bridgeOnline && prompt.value.trim().length > 0 && workspace.value.length > 0,
);

const capacityText = computed(() => {
  const cap = props.capacity;
  if (!cap) return "";
  const queued = cap.queued ? ` · 排队 ${cap.queued}` : "";
  return `${cap.running}/${cap.maxRunning} 运行${queued}`;
});

function submit(): void {
  if (!canCreate.value) return;
  emit("create", { prompt: prompt.value.trim(), workspace: workspace.value, isolation: isolation.value });
  prompt.value = "";
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
        <span class="label muted">工作目录</span>
        <select v-model="workspace">
          <option v-for="ws in props.workspaces" :key="ws" :value="ws">{{ ws }}</option>
        </select>
      </label>
      <label class="check">
        <input v-model="isolation" type="checkbox" :true-value="'worktree'" :false-value="'shared'" />
        <span>worktree 隔离（同一仓库并行跑时用）</span>
      </label>
      <textarea v-model="prompt" rows="3" placeholder="要它做什么？例：修一下登录接口的 500" />
      <div class="actions">
        <button :disabled="props.busy" @click="showComposer = false">取消</button>
        <button class="primary" :disabled="!canCreate || props.busy" @click="submit">新任务</button>
      </div>
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
.check { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--fg-dim); }
.check input { width: auto; }
.actions { display: flex; gap: 10px; }
.actions button { flex: 1; }
.error { color: var(--err); font-size: 12px; }
</style>
