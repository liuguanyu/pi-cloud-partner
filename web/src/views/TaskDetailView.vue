<script setup lang="ts">
/**
 * 任务详情：时间线 + 审批 + 继续输入。
 *
 * 这里的输入框语义 = **steer / follow_up**（继续这个任务），
 * 与列表页的「新任务」是两件事，见 protocol/control.md §5。
 */
import { computed, nextTick, ref, watch } from "vue";
import MessageBlock from "../components/MessageBlock.vue";
import ToolCard from "../components/ToolCard.vue";
import ApprovalSheet from "../components/ApprovalSheet.vue";
import { isTerminal, type TaskView } from "../core/store.ts";
import type { UiRequestPayload } from "@wire";

const props = defineProps<{
  task?: TaskView;
  busy?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  back: [];
  steer: [text: string];
  cancel: [];
  answer: [approval: UiRequestPayload & { taskId: string }, decision: "approve" | "deny" | { value: unknown }];
}>();

const scroller = ref<HTMLElement | null>(null);
const draft = ref("");

const terminal = computed(() => (props.task ? isTerminal(props.task.status) : true));
const canSend = computed(() => !terminal.value && draft.value.trim().length > 0);

watch(
  () => props.task?.blocks.length,
  async () => {
    await nextTick();
    const node = scroller.value;
    if (node) node.scrollTop = node.scrollHeight;
  },
);

function send(): void {
  if (!canSend.value) return;
  emit("steer", draft.value.trim());
  draft.value = "";
}
</script>

<template>
  <div class="detail">
    <div ref="scroller" class="timeline">
      <p v-if="!props.task" class="muted center">任务不存在或尚未同步</p>
      <template v-else>
        <div class="headline">
          <h2>{{ props.task.title }}</h2>
          <div class="sub muted">
            <span class="pill" :data-status="props.task.status">{{ props.task.status }}</span>
            <span v-if="props.task.workspace" class="mono">{{ props.task.workspace }}</span>
            <span v-if="props.task.isolation === 'worktree'" class="pill">worktree</span>
          </div>
        </div>

        <template v-for="(block, index) in props.task.blocks" :key="index">
          <ToolCard v-if="block.kind === 'tool'" :block="block" />
          <MessageBlock
            v-else-if="block.kind === 'text' || block.kind === 'user' || block.kind === 'thinking'"
            :kind="block.kind"
            :text="block.text"
          />
        </template>

        <p v-if="props.task.blocks.length === 0" class="muted center">等待输出…</p>

        <div v-if="props.task.exitReason" class="exit muted">
          结束原因：{{ props.task.exitReason }}
        </div>
      </template>
    </div>

    <footer>
      <button v-if="!terminal" class="danger" :disabled="props.busy" @click="emit('cancel')">中断</button>
      <textarea
        v-model="draft"
        rows="1"
        :disabled="terminal"
        :placeholder="terminal ? '任务已结束' : '插话（steer），不新建任务'"
        @keydown.enter.exact.prevent="send"
      />
      <button class="primary" :disabled="!canSend || props.busy" @click="send">发送</button>
    </footer>

    <p v-if="props.error" class="error">{{ props.error }}</p>

    <ApprovalSheet
      v-if="props.task?.pendingApproval"
      :approval="props.task.pendingApproval"
      :busy="props.busy"
      @decide="(decision) => emit('answer', props.task!.pendingApproval!, decision)"
    />
  </div>
</template>

<style scoped>
.detail { display: flex; flex-direction: column; height: 100%; }

.timeline {
  flex: 1;
  overflow-y: auto;
  padding: 14px 14px 8px;
  -webkit-overflow-scrolling: touch;
}

.headline h2 { font-size: 16px; margin: 0 0 6px; }
.headline .sub { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-bottom: 10px; flex-wrap: wrap; }

.center { text-align: center; color: var(--fg-dim); font-size: 13px; padding: 24px 0; }
.exit { font-size: 12px; padding: 10px 0; }

footer {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--line);
  background: var(--bg-soft);
}
footer textarea { flex: 1; max-height: 96px; font-size: 14px; }
footer button { flex: 0 0 auto; padding: 10px 14px; }

.error { color: var(--err); font-size: 12px; padding: 0 14px 8px; margin: 0; }
</style>
