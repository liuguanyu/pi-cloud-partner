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
import type { UiRequestPayload } from "@wire";

const { state, actions } = useBridge();

const route = ref<string>(location.hash || "#/");
const busy = ref(false);
const actionError = ref<string | undefined>(undefined);

window.addEventListener("hashchange", () => {
  route.value = location.hash || "#/";
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

watch(activeTaskId, (taskId) => {
  // 告诉 bridge 当前聚焦谁，决定推全量 delta 还是只推摘要
  void actions.focusTask(taskId);
});

onMounted(() => {
  bootstrap();
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
      v-if="state.phase === 'need-token' || state.phase === 'need-pair' || state.phase === 'waiting-approval'"
      :phase="state.phase"
      :pairs="state.pairs"
      :error="actionError ?? state.error"
      :busy="busy"
      @submit-token="(token) => run(() => actions.submitUserToken(token))"
      @claim="(code, name) => run(() => actions.claim(code, name))"
    />

    <div v-else-if="state.phase === 'booting'" class="booting muted">正在连接…</div>

    <div v-else-if="state.phase === 'error'" class="booting">
      <p class="error">{{ state.error }}</p>
      <button @click="run(() => actions.submitUserToken(state.credentials.userToken ?? ''))">重试</button>
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
        :capacity="state.capacity"
        :bridge-online="state.view.bridgeOnline"
        :primed="state.primed"
        :busy="busy"
        :error="actionError"
        @create="handleCreate"
        @open="(taskId) => go(`#/t/${encodeURIComponent(taskId)}`)"
      />
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
