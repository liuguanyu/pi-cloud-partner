/**
 * bridge → 云端的 blob 上传（agent 产出的图片转存）。
 *
 * pi 事件里的图片是 base64 内联的；大图直接过 wss 帧会撞尺寸上限。
 * 超过阈值的在转发前传成 blob，事件里换成引用（手机再用签名 URL 渲染）。
 */

import { readFileSync } from "node:fs";

export interface BlobUploadResult {
  blobId: string;
  kind?: string;
  name?: string;
  mimeType?: string;
}

/** 小于该长度（字节）的 base64 直接内联，省一次 HTTP 往返。512KB 的 base64 事件完全可承受。 */
export const INLINE_IMAGE_B64_LIMIT = 512 * 1024;

export interface UploaderOptions {
  baseUrl: string;
  deviceToken: string;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface BlobUploader {
  /**
   * 上传 base64 图片。
   * @returns 成功返回 blobId；失败返回 undefined（调用方需自行降级，避免大图卡住事件流）。
   */
  uploadImage(
    base64Data: string,
    mimeType: string,
    pairId: string,
    name?: string,
  ): Promise<BlobUploadResult | undefined>;
  /** 读本地文件上传（pcp_send 用）。 */
  uploadLocalFile(
    filePath: string,
    mimeType: string,
    pairId: string,
    name: string,
  ): Promise<BlobUploadResult | undefined>;
}

export function createUploader(opts: UploaderOptions): BlobUploader {
  return {
    async uploadImage(base64Data, mimeType, pairId, name) {
      const buf = Buffer.from(base64Data, "base64");
      return uploadBuffer(buf, mimeType, name ?? `agent-${Date.now()}.png`, pairId, opts);
    },
    async uploadLocalFile(filePath, mimeType, pairId, name) {
      let buf: Buffer;
      try {
        buf = readFileSync(filePath);
      } catch (error) {
        opts.log?.("pcp_send 读文件失败", { filePath, error: String(error) });
        return undefined;
      }
      return uploadBuffer(buf, mimeType, name, pairId, opts);
    },
  };
}

async function uploadBuffer(
  buf: Buffer,
  mimeType: string,
  name: string,
  pairId: string,
  opts: UploaderOptions,
): Promise<BlobUploadResult | undefined> {
  const form = new FormData();
  // Blob 带正确的 type，服务端 mime 兜底才不会把 png 存成 octet-stream
  form.append("file", new Blob([buf], { type: mimeType }), name);
  let response: Response;
  try {
    response = await fetch(
      `${opts.baseUrl}/api/blob?pairId=${encodeURIComponent(pairId)}`,
      { method: "POST", headers: { Authorization: `Device ${opts.deviceToken}` }, body: form },
    );
  } catch (error) {
    opts.log?.("文件上传失败（网络）", { error: String(error), bytes: buf.byteLength });
    return undefined;
  }
  if (!response.ok) {
    opts.log?.("文件上传失败", { status: response.status, bytes: buf.byteLength });
    return undefined;
  }
  const payload = (await response.json()) as BlobUploadResult;
  return payload?.blobId ? payload : undefined;
}
