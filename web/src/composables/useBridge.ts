/**
 * Vue 适配层：**唯一**允许 import vue 的地方。
 *
 * 职责：把纯 TS 的 AppController 的不可变快照接成 Vue 响应式。
 * 组件只通过这里拿数据与动作，不直接碰 core 的 transport。
 */
import { onScopeDispose, ref, shallowRef, type Ref } from "vue";
import { AppController, type AppState } from "../core/app.ts";
import type { UiRequestPayload } from "@wire";

export interface BridgeApi {
  state: Ref<AppState>;
  actions: {
    claim(code: string, deviceName: string): Promise<void>;
    upload(file: File): Promise<{ blobId: string; kind?: string; name?: string; mimeType?: string }>;
    resolveBlobUrl(blobId: string, force?: boolean): Promise<string>;
    startTask(input: {
      prompt: string;
      workspace: string;
      isolation?: "shared" | "worktree";
      blobs?: Array<{ blobId: string; kind?: string; name?: string; mimeType?: string }>;
    }): Promise<string>;
    steerTask(taskId: string, text: string, mode?: "steer" | "follow_up"): Promise<void>;
    cancelTask(taskId: string): Promise<void>;
    focusTask(taskId: string | null): Promise<void>;
    answer(approval: UiRequestPayload & { taskId: string }, decision: "approve" | "deny" | { value: unknown }): Promise<void>;
    revokePair(): Promise<void>;
    unpair(): Promise<void>;
    loadHistory(taskId: string): Promise<void>;
    refreshWorkspaces(): Promise<void>;
    refresh(): Promise<void>;
  };
}

let controller: AppController | null = null;

function getController(): AppController {
  if (!controller) {
    controller = new AppController({ storage: window.localStorage });
  }
  return controller;
}

/**
 * 组合根是单例（一个页面只有一条 SSE 流），但每个组件拿到的是独立的快照引用。
 * shallowRef 只跟踪引用变化 —— store 内部已经是不可变快照，不需要深追踪。
 */
export function useBridge(): BridgeApi {
  const app = getController();
  const state = shallowRef<AppState>(app.state());
  const unsubscribe = app.subscribe(() => {
    state.value = app.state();
  });

  onScopeDispose(() => {
    unsubscribe();
  });

  void ref; // 保留 import 以备扩展

  return {
    state,
    actions: {
      claim: (code, deviceName) => app.claim(code, deviceName),
      upload: (file) => app.upload(file),
      resolveBlobUrl: (blobId, force) => app.resolveBlobUrl(blobId, force),
      startTask: (input) => app.startTask(input),
      steerTask: (taskId, text, mode) => app.steerTask(taskId, text, mode),
      cancelTask: (taskId) => app.cancelTask(taskId),
      focusTask: (taskId) => app.focusTask(taskId),
      answer: (approval, decision) => app.answerApproval(approval, decision),
      revokePair: () => app.revokePair(),
      unpair: () => app.unpair(),
      loadHistory: (taskId) => app.loadHistory(taskId),
      refreshWorkspaces: () => app.refreshWorkspaces(),
      refresh: () => app.refresh(),
    },
  };
}

/** 只在 App 根部调用一次。 */
export function bootstrap(): void {
  void getController().bootstrap();
}
