/**
 * 附件落地（bridge 侧）。
 *
 * 手机上传的截图/文件先存云端 blob，事件流里只传 blobId。这里把它们取回来，
 * 变成 pi 能消费的两种形态：
 *
 *   图片 → `ImageContent`（base64 + mimeType），pi 直接喂给模型
 *   其它 → 写进工作区的 `.pcp-uploads/`，并在 prompt 里附上路径，
 *          让 agent 用它自己的 read/grep 去处理（比塞进 prompt 可靠得多）
 *
 * 为什么文件不内联进 prompt：pi 的 prompt 只接受文本与图片；二进制塞进去要么
 * 被截断，要么撑爆帧。落盘 + 给路径是唯一稳妥的做法。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface BlobRef {
  blobId: string;
  kind?: string;
  name?: string;
  mimeType?: string;
}

export interface MaterializeOptions {
  /** 云端 HTTP 基址（https://host） */
  baseUrl: string;
  /** deviceToken：bridge 用设备凭据下载自己的附件 */
  deviceToken: string;
  /** 工作区目录（落盘位置） */
  workspace: string;
  /** 单个附件上限，避免把内存打满 */
  maxBytes?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface Materialized {
  /** 直接喂给 pi 的图片 */
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  /** 追加到 prompt 末尾的说明（落盘文件） */
  notes: string[];
  /** 上传目录，便于任务结束后清理/查看 */
  uploadDir?: string;
}

const UPLOAD_DIR = ".pcp-uploads";
const DEFAULT_MAX_BYTES = 16 << 20;

/** 只保留安全字符，避免路径穿越与奇怪文件名。 */
function safeName(name: string | undefined, index: number): string {
  const base = (name ?? "").split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[^\w.\-]/g, "_").replace(/^\.+/, "");
  return cleaned || `file-${index + 1}`;
}

export async function materializeBlobs(
  blobs: BlobRef[],
  opts: MaterializeOptions,
): Promise<Materialized> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const images: Materialized["images"] = [];
  const notes: string[] = [];
  let uploadDir: string | undefined;

  for (let i = 0; i < blobs.length; i += 1) {
    const blob = blobs[i];
    if (!blob?.blobId) continue;

    let response: Response;
    try {
      response = await fetch(`${opts.baseUrl}/blob/${encodeURI(blob.blobId)}`, {
        headers: { Authorization: `Device ${opts.deviceToken}` },
      });
    } catch (error) {
      opts.log?.("附件下载失败（网络）", { blobId: blob.blobId, error: String(error) });
      notes.push(`（附件 ${blob.name ?? blob.blobId} 下载失败）`);
      continue;
    }
    if (!response.ok) {
      opts.log?.("附件下载失败", { blobId: blob.blobId, status: response.status });
      notes.push(`（附件 ${blob.name ?? blob.blobId} 下载失败：HTTP ${response.status}）`);
      continue;
    }

    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      opts.log?.("附件过大，已跳过", { blobId: blob.blobId, bytes: buf.byteLength });
      notes.push(`（附件 ${blob.name ?? blob.blobId} 超过 ${Math.round(maxBytes / 1048576)}MB，已跳过）`);
      continue;
    }

    const mime = blob.mimeType || response.headers.get("content-type") || "application/octet-stream";
    if ((blob.kind === "image" || mime.startsWith("image/")) && isModelReadableImage(mime)) {
      // SVG 等 pi 不认的格式走落盘分支
      images.push({ type: "image", data: buf.toString("base64"), mimeType: mime });
      continue;
    }

    if (!uploadDir) {
      uploadDir = join(opts.workspace, UPLOAD_DIR);
      await mkdir(uploadDir, { recursive: true });
    }
    const target = join(uploadDir, safeName(blob.name, i));
    await writeFile(target, buf);
    notes.push(`- ${UPLOAD_DIR}/${safeName(blob.name, i)}（原始文件名 ${blob.name ?? "未命名"}，${formatBytes(buf.byteLength)}）`);
  }

  if (notes.length > 0) {
    // 给 agent 的说明放在 prompt 末尾，明确"这些是用户上传的"，避免它以为是仓库里的东西
    const header = "\n\n用户上传了以下附件，可直接用工具查看：";
    notes.push("");
    return { images, notes: [header, ...notes], ...(uploadDir ? { uploadDir } : {}) };
  }
  return uploadDir ? { images, notes, uploadDir } : { images, notes };
}

/** pi 能作为图片内容消费的 mime（svg/pdf 不行，走落盘） */
function isModelReadableImage(mime: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(mime);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1048576).toFixed(1)}MB`;
}
