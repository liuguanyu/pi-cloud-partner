<script setup lang="ts">
/**
 * 应用外壳：只做三件事 —— 显隐路由、选视图、把动作转给 controller。
 *
 * 路由极简（hash）：`#/` 列表，`#/t/<taskId>` 详情。
 * 三个视图之间没有共享状态，全部来自 useBridge 的快照。
 */
import { computed, onMounted, ref, watch } from "vue";
import { bootstrap, useBridge } from "./composables/useBridge.ts";
import PairingView from "./views/PairingView.vue";
import TaskListView from "./views/TaskListView.vue";
import TaskDetailView from "./views/TaskDetailView.vue";
import DeviceView from "./views/DeviceView.vue";
import type { UiRequestPayload } from "@wire";

/**
 * 本地控制台模式（/device）。
 *
 * 双重判定，缺一不可：
 *   1. hostname 必须是回环地址 —— 公网域名下即使手动访问 #/device 也不渲染
 *   2. hash 为 #/device
 * 这样"设备端页面"不可能被外网访问到（它本来也只由 bridge 在本地提供）。
 */
const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(location.hostname);
const deviceMode = ref(isLoopback && (location.hash === "#/device" || location.pathname === "/device"));

const { state, actions } = useBridge();

const route = ref<string>(location.hash || "#/");

/**
 * 扫码链接形如 https://host/m?code=ABC123。
 * 读出码预填到配对页，然后把 query 从地址栏抹掉 —— 否则刷新会拿一个已用过的码重填。
 */
const initialPairCode = ref<string>(new URLSearchParams(location.search).get("code") ?? "");
const busy = ref(false);
const actionError = ref<string | undefined>(undefined);

window.addEventListener("hashchange", () => {
  route.value = location.hash || "#/";
  deviceMode.value = isLoopback && (location.hash === "#/device" || location.pathname === "/device");
});

const activeTaskId = computed(() => {
  const match = /^#\/t\/([^/]+)$/.exec(route.value);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
});

const activeTask = computed(() => (activeTaskId.value ? state.value.view.byId[activeTaskId.value] : undefined));
const approvals = computed(() => state.value.view.approvals);

const sseLabel = computed(
  () =>
    ({
      idle: "未连接",
      connecting: "连接中",
      online: "已连接",
      offline: "重连中",
    })[state.value.sseStatus],
);

watch(
  activeTaskId,
  (taskId) => {
    // 告诉 bridge 当前聚焦谁，决定推全量 delta 还是只推摘要
    void actions.focusTask(taskId);
  },
  { immediate: true },
);

// 详情页打开后，如果本地内容不完整就去磁盘拉一次历史。
// 判据用「blocks 为空」而不是「任务已结束」：云端重启会清空 ring，
// 进行中的任务同样会变成"本地什么都没有"，此时更应该显示磁盘上的真实进度。
watch(
  () => activeTask.value,
  (task) => {
    if (!task) return;
    if (task.historyLoaded) return;
    if (task.blocks.length > 0) return;
    void run(() => actions.loadHistory(task.taskId));
  },
);

onMounted(() => {
  if (initialPairCode.value) {
    const cleaned = location.pathname + location.hash;
    window.history.replaceState(null, "", cleaned);
  }
  // 本地控制台不需要配对凭据，别去跑手机端的 bootstrap
  if (!deviceMode.value) bootstrap();
});

function go(hash: string): void {
  location.hash = hash;
}

async function run<T>(fn: () => Promise<T>): Promise<void> {
  busy.value = true;
  actionError.value = undefined;
  try {
    await fn();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

async function handleCreate(input: { prompt: string; workspace: string; isolation: "shared" | "worktree" }): Promise<void> {
  await run(async () => {
    const taskId = await actions.startTask(input);
    go(`#/t/${encodeURIComponent(taskId)}`);
  });
}

async function handleAnswer(
  approval: UiRequestPayload & { taskId: string },
  decision: "approve" | "deny" | { value: unknown },
): Promise<void> {
  await run(() => actions.answer(approval, decision));
}
</script>

<template>
  <div class="app">
    <!-- 设备端页面独立成支，不与手机端共用任何 header/状态 -->
    <DeviceView v-if="deviceMode" />

    <template v-else>
    <header v-if="state.phase === 'ready'">
      <button v-if="activeTaskId" class="back" @click="go('#/')">←</button>
      <div class="brand">
        <span class="dot" :data-on="state.view.bridgeOnline ? 'true' : 'false'" />
        <strong>pi</strong>
        <span class="muted sse">{{ sseLabel }}</span>
      </div>
      <button class="ghost" @click="run(() => actions.revokePair())">断开</button>
    </header>

    <div v-if="approvals.length > 0 && !activeTask?.pendingApproval" class="approval-banner" @click="go(`#/t/${approvals[0]!.taskId}`)">
      {{ approvals.length }} 个操作等待审批 →
    </div>

    <PairingView
      v-if="state.phase === 'need-pair' || state.phase === 'waiting-approval'"
      :phase="state.phase"
      :pairs="state.pairs"
      :error="actionError ?? state.error"
      :busy="busy"
      :initial-code="initialPairCode"
      @claim="(code, name) => run(() => actions.claim(code, name))"
    />

    <div v-else-if="state.phase === 'booting'" class="booting muted">正在连接…</div>

    <div v-else-if="state.phase === 'error'" class="booting">
      <p class="error">{{ state.error }}</p>
      <button @click="run(() => actions.unpair())">重新配对</button>
    </div>

    <template v-else>
      <TaskDetailView
        v-if="activeTaskId"
        :task="activeTask"
        :busy="busy"
        :error="actionError"
        @back="go('#/')"
        @steer="(text) => run(() => actions.steerTask(activeTaskId!, text))"
        @cancel="run(() => actions.cancelTask(activeTaskId!))"
        @answer="handleAnswer"
      />
      <TaskListView
        v-else
        :tasks="state.view.tasks"
        :workspaces="state.workspaces"
        :dirs="state.dirs"
        :capacity="state.capacity"
        :bridge-online="state.view.bridgeOnline"
        :primed="state.primed"
        :busy="busy"
        :error="actionError"
        @create="handleCreate"
        @open="(taskId) => go(`#/t/${encodeURIComponent(taskId)}`)"
      />
    </template>
    </template>
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100%; }

header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: calc(10px + env(safe-area-inset-top)) 12px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--bg);
  position: sticky;
  top: 0;
  z-index: 20;
}
header .brand { display: flex; align-items: center; gap: 8px; flex: 1; }
header .sse { font-size: 12px; }
.back, .ghost {
  background: transparent;
  border: 1px solid var(--line);
  padding: 6px 11px;
  font-size: 13px;
}

.approval-banner {
  background: #33220f;
  border-bottom: 1px solid #5a3a17;
  color: #f0883e;
  font-size: 13px;
  padding: 10px 14px;
  cursor: pointer;
}

.booting { padding: 40px 20px; text-align: center; font-size: 14px; }
.error { color: var(--err); margin-bottom: 14px; }
</style>
