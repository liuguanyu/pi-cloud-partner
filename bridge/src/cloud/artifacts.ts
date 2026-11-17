/**
 * pcp_send 的"发送记录"。
 *
 * pi 的 JSONL 不存自定义工具的 details（实测确认），所以"agent 给用户发过什么文件"
 * 没法从会话文件回放。这里在 bridge 侧另记一条 sidecar：
 *   ~/.pi/bridge/artifacts/<taskId>.jsonl
 * 每行 { taskId, blobId, kind, name, mimeType, bytes, note, at }。
 *
 * 为什么按 taskId 存（而不是按 session）：pcp_send 是"这次任务里发的东西"，
 * 跟任务强相关；同一 session 被多个任务复用时不会串。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ArtifactRecord {
  taskId: string;
  blobId: string;
  kind: string;
  name: string;
  mimeType: string;
  bytes: number;
  note?: string;
  at: number;
}

export interface ArtifactBlock {
  kind: "blobImage" | "file";
  blobId: string;
  name: string;
  mimeType?: string;
  bytes?: number;
  note?: string;
}

const DIRNAME = "artifacts";

export function artifactDir(baseDir: string): string {
  return join(baseDir, DIRNAME);
}

export function artifactFile(baseDir: string, taskId: string): string {
  return join(artifactDir(baseDir), `${safeId(taskId)}.jsonl`);
}

/** 记录一条发送。失败不影响任务（只是历史回看少一块）。 */
export function recordArtifact(baseDir: string, rec: ArtifactRecord): void {
  try {
    const dir = artifactDir(baseDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(artifactFile(baseDir, rec.taskId), JSON.stringify(rec) + "\n");
  } catch {
    /* 记录失败静默：发送本身已成功 */
  }
}

/** 读某任务的全部发送记录（用于历史回放合并）。 */
export function loadArtifacts(baseDir: string, taskId: string): ArtifactRecord[] {
  const file = artifactFile(baseDir, taskId);
  if (!existsSync(file)) return [];
  const out: ArtifactRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ArtifactRecord);
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

/**
 * 把发送记录转成可渲染的块，并按 blobId 去重（同一文件可能被 agent 发两次，
 * 云端 blob 已去重，回放时显示一次即可）。
 *
 * 顺序：按发送时间（记录顺序）追加到历史块**末尾**——发送发生在对话之后，
 * 放在末尾比插到中间更符合时间线。
 */
export function artifactsToBlocks(records: ArtifactRecord[]): ArtifactBlock[] {
  const seen = new Set<string>();
  const blocks: ArtifactBlock[] = [];
  for (const rec of records) {
    if (seen.has(rec.blobId)) continue;
    seen.add(rec.blobId);
    blocks.push({
      kind: rec.kind === "image" ? "blobImage" : "file",
      blobId: rec.blobId,
      name: rec.name,
      mimeType: rec.mimeType,
      bytes: rec.bytes,
      note: rec.note,
    });
  }
  return blocks;
}

function safeId(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
}
