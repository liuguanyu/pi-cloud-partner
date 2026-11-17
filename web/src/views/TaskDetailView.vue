<script setup lang="ts">
/**
 * 任务详情：时间线 + 审批 + 继续输入。
 *
 * 这里的输入框语义 = **steer / follow_up**（继续这个任务），
 * 与列表页的「新任务」是两件事，见 protocol/control.md §5。
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import MessageBlock from "../components/MessageBlock.vue";
import ToolCard from "../components/ToolCard.vue";
import ImageBlock from "../components/ImageBlock.vue";
import FileBlock from "../components/FileBlock.vue";
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
/** 视口是否贴在底部；只有贴底时才自动跟随新内容 */
const atBottom = ref(true);
/** 用户翻到上面后又来了新内容，用这个提示他 */
const hasNewBelow = ref(false);

const terminal = computed(() => (props.task ? isTerminal(props.task.status) : true));
const canSend = computed(() => !terminal.value && draft.value.trim().length > 0);
const showJump = computed(() => !atBottom.value);

const BOTTOM_THRESHOLD_PX = 80;

function measure(): void {
  const node = scroller.value;
  if (!node) return;
  const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
  const bottom = distance < BOTTOM_THRESHOLD_PX;
  atBottom.value = bottom;
  if (bottom) hasNewBelow.value = false;
}

function scrollToBottom(smooth = false): void {
  const node = scroller.value;
  if (!node) return;
  node.scrollTo({ top: node.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  atBottom.value = true;
  hasNewBelow.value = false;
}

/**
 * 跟随新内容。
 *
 * 注意监听的是 **cursor（事件水位）** 而不是 blocks.length：
 * 流式打印是在同一个 block 内追加文本，块数不变，
 * 只监听块数的话"边打边滚"根本不成立（之前的 bug）。
 */
watch(
  () => [props.task?.cursor, props.task?.blocks.length] as const,
  async () => {
    await nextTick();
    if (atBottom.value) {
      scrollToBottom();
    } else {
      hasNewBelow.value = true;
    }
  },
);

// 打开任务时直接落到最新位置
watch(
  () => props.task?.taskId,
  async () => {
    await nextTick();
    atBottom.value = true;
    scrollToBottom();
  },
);

onMounted(async () => {
  await nextTick();
  scrollToBottom();
});

/**
 * 空内容时的文案。
 * 不能一律写"等待输出…"——任务已经结束了却还显示等待，会让人以为还在跑。
 */
function emptyHint(task: TaskView): string {
  if (!isTerminal(task.status)) return "等待输出…";
  if (task.exitReason === "not_started") {
    return "任务没有开始：下发时与电脑的连接中断了，重新发一次即可。";
  }
  if (task.exitReason === "state_lost") {
    return "任务中途与电脑失联，最终状态未同步。";
  }
  if (task.status === "failed") return "任务失败了，没有产生输出。";
  if (task.status === "cancelled") return "任务已取消。";
  return "这次任务没有产生输出。";
}

function send(): void {
  if (!canSend.value) return;
  emit("steer", draft.value.trim());
  draft.value = "";
}
</script>

<template>
  <div class="detail">
    <div ref="scroller" class="timeline" @scroll.passive="measure">
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
          <ImageBlock
            v-else-if="block.kind === 'image'"
            kind="image"
            :data="block.data"
            :mimeType="block.mimeType"
          />
          <ImageBlock
            v-else-if="block.kind === 'blobImage'"
            kind="blobImage"
            :blobId="block.blobId"
            :mimeType="block.mimeType"
            :name="block.name"
          />
          <FileBlock v-else-if="block.kind === 'file'" :block="block" />
        </template>

        <p v-if="props.task.blocks.length === 0" class="muted center">
          {{ emptyHint(props.task) }}
        </p>

        <div v-if="props.task.exitReason" class="exit muted">
          结束原因：{{ props.task.exitReason }}
        </div>
      </template>
    </div>

    <button v-if="showJump" class="jump" @click="scrollToBottom(true)">
      ↓ 回到最新<template v-if="hasNewBelow"> · 有新内容</template>
    </button>

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
.detail { position: relative; display: flex; flex-direction: column; height: 100%; }

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

/* 翻上去之后才出现；贴在右下、输入框之上 */
.jump {
  position: absolute;
  right: 14px;
  bottom: calc(76px + env(safe-area-inset-bottom));
  padding: 8px 14px;
  border-radius: 999px;
  font-size: 12px;
  background: var(--bg-raise);
  border: 1px solid var(--line);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
  color: var(--fg);
  z-index: 10;
}
</style>
