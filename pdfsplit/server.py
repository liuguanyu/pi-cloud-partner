#!/usr/bin/env python3
"""pdfsplit —— 按书签分割 PDF 的小站服务。

    GET  /                  上传页
    POST /api/upload?name=  原始 PDF 字节（不带 multipart，前端直接 PUT body）
    GET  /api/dl/<token>    下载分割后的 zip
    GET /api/manifest/<token>  分割清单（JSON）

设计：
- 分割逻辑与本地验证过的脚本完全一致（严格校验：首个书签必须从第 1 页开始、
  去重后按页排序、禁止同页歧义、输出页数守恒校验）——保证不丢任何内容、
  忠实原 PDF（逐页复制，不渲染不重排）。
- 只监听 127.0.0.1，由 nginx 的 /pdfsplit/ 前缀路由进来（^~ 优先于正则，
  不影响 lab.leon82.com 的其它功能）。
- 产物放内存 tmp 目录，2 小时后自动清理。
"""
from __future__ import annotations

import io
import json
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
import zipfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from pypdf import PdfReader, PdfWriter

MAX_UPLOAD = 512 * 1024 * 1024  # 与 nginx location 内的 client_max_body_size 一致
TTL_SECONDS = 2 * 60 * 60

# 工作目录可被环境变量覆盖（systemd 沙箱用 StateDirectory=/var/lib/pdfsplit）
WORK_ROOT = Path(os.environ.get("PCP_PDFSPLIT_DIR") or (Path(tempfile.gettempdir()) / "pdfsplit-jobs"))

INDEX_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PDF 按书签分割</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0d1117; color: #e6edf3;
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    padding: 24px;
  }
  .card {
    width: 100%; max-width: 560px; background: #161b22; border: 1px solid #30363d;
    border-radius: 14px; padding: 28px;
  }
  h1 { font-size: 20px; margin: 0 0 6px; }
  .sub { color: #8b949e; font-size: 13px; line-height: 1.6; margin: 0 0 20px; }
  .drop {
    position: relative;
    border: 2px dashed #30363d; border-radius: 12px; padding: 34px 16px; text-align: center;
    cursor: pointer; transition: border-color .15s, background .15s;
  }
  .drop:hover, .drop.over { border-color: #4d9fff; background: #111827; }
  /* 透明 file input 直接盖在拖放区上：用户点到的就是 input 本身。
     不能用 JS input.click() + hidden——iOS Safari 对 display:none 的 input
     静默忽略 click()，选择器不弹（实测踩过）。原生点击必然呼起。 */
  .drop input[type="file"] {
    position: absolute; inset: 0; width: 100%; height: 100%;
    opacity: 0; cursor: pointer; font-size: 0;
  }
  .drop .big { font-size: 34px; }
  .drop .hint { color: #8b949e; font-size: 13px; margin-top: 8px; }
  .fname { margin-top: 12px; font-size: 13px; color: #79c0ff; word-break: break-all; }
  button {
    margin-top: 18px; width: 100%; padding: 11px; border: 0; border-radius: 9px;
    background: #1f6feb; color: #fff; font-size: 15px; cursor: pointer;
  }
  button:disabled { background: #21262d; color: #6e7681; cursor: not-allowed; }
  .bar { height: 8px; background: #21262d; border-radius: 4px; overflow: hidden; margin-top: 16px; display: none; }
  .bar > div { height: 100%; width: 0; background: #3fb950; transition: width .2s; }
  .msg { margin-top: 14px; font-size: 13px; line-height: 1.7; white-space: pre-wrap; word-break: break-all; }
  .msg.err { color: #f85149; }
  .msg.ok { color: #3fb950; }
  ol { margin: 10px 0 0; padding-left: 20px; color: #8b949e; font-size: 12px; line-height: 1.9;
       max-height: 240px; overflow: auto; }
</style>
</head>
<body>
<div class="card">
  <h1>PDF 按书签分割</h1>
  <p class="sub">上传带书签（outline）的 PDF，按每个书签的起始页切成独立文件，打包 zip 下载。
  仅做分割：逐页复制、不渲染不重排，输出页数与原文件严格校验一致。</p>

  <div class="drop" id="drop">
    <div class="big">📄</div>
    <div>点击选择 PDF，或拖进来</div>
    <div class="hint">≤ 512MB</div>
    <input type="file" id="file" accept="application/pdf,.pdf">
  </div>
  <div class="fname" id="fname"></div>

  <button id="go" disabled>分割并下载 zip</button>
  <div class="bar" id="bar"><div></div></div>
  <div class="msg" id="msg"></div>
  <ol id="list" hidden></ol>
</div>

<script>
const $ = (id) => document.getElementById(id);
const drop = $("drop"), fileInput = $("file"), go = $("go");
let file = null;

drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault(); drop.classList.remove("over");
  if (e.dataTransfer.files.length) pick(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => { if (fileInput.files.length) pick(fileInput.files[0]); });

function pick(f) {
  if (!/\\.pdf$/i.test(f.name) && f.type !== "application/pdf") {
    show("只支持 PDF 文件", true); return;
  }
  if (f.size > 512 * 1024 * 1024) { show("文件超过 512MB", true); return; }
  file = f;
  $("fname").textContent = f.name + "（" + (f.size / 1048576).toFixed(1) + " MB）";
  go.disabled = false;
  show("");
}

function show(text, isErr) {
  const m = $("msg");
  m.textContent = text;
  m.className = "msg" + (isErr ? " err" : "");
}

go.addEventListener("click", () => {
  if (!file) return;
  go.disabled = true;
  $("bar").style.display = "block";
  setBar(4);
  show("上传中…");

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "api/upload?name=" + encodeURIComponent(file.name));
  xhr.setRequestHeader("Content-Type", "application/pdf");
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) setBar(4 + (e.loaded / e.total) * 76);
  };
  xhr.onload = () => {
    setBar(96);
    if (xhr.status !== 200) {
      let detail = "";
      try { detail = JSON.parse(xhr.responseText).error || ""; } catch (_) {}
      finish("失败：" + (detail || ("HTTP " + xhr.status)), true);
      return;
    }
    let data;
    try { data = JSON.parse(xhr.responseText); } catch (_) { finish("响应解析失败", true); return; }
    setBar(100);
    // 呼起下载
    const a = document.createElement("a");
    a.href = data.download;
    a.download = data.zipName;
    document.body.appendChild(a); a.click(); a.remove();
    const parts = data.manifest.map(m => m.file + "（p" + m.start_page + "–p" + m.end_page + "，" + m.pages + " 页）");
    $("list").innerHTML = parts.map(p => "<li>" + p + "</li>").join("");
    $("list").hidden = false;
    finish("完成：共 " + data.manifest.length + " 个文件，zip 已开始下载");
  };
  xhr.onerror = () => finish("网络错误", true);
  xhr.send(file);
});

function setBar(p) { $("bar").firstElementChild.style.width = p + "%"; }
function finish(text, isErr) {
  show(text, isErr);
  setTimeout(() => { $("bar").style.display = "none"; }, 600);
  go.disabled = false;
}
</script>
</body>
</html>
"""


def flatten_outline(outline: list[Any], reader: PdfReader) -> list[tuple[int, str]]:
    result: list[tuple[int, str]] = []
    for item in outline:
        if isinstance(item, list):
            result.extend(flatten_outline(item, reader))
            continue
        page_number = reader.get_destination_page_number(item)
        result.append((page_number, str(item.title)))
    return result


def safe_filename(title: str) -> str:
    title = re.sub(r'[\\/:*?"<>|]+', "_", title).strip().rstrip(".")
    return (title or "untitled")[:150]


def copy_metadata(reader: PdfReader, writer: PdfWriter) -> None:
    if reader.metadata:
        metadata = {str(k): str(v) for k, v in reader.metadata.items() if k and v is not None}
        if metadata:
            writer.add_metadata(metadata)


def split_pdf(source: Path, output_dir: Path) -> list[dict[str, object]]:
    reader = PdfReader(str(source), strict=False)
    total_pages = len(reader.pages)
    bookmarks = flatten_outline(reader.outline, reader)
    if not bookmarks:
        raise ValueError("PDF 没有可用的书签（outline），无法分割。")

    seen: set[tuple[int, str]] = set()
    starts: list[tuple[int, str]] = []
    for page, title in bookmarks:
        key = (page, title)
        if key not in seen:
            seen.add(key)
            starts.append(key)
    starts.sort(key=lambda item: item[0])

    if starts[0][0] != 0:
        raise ValueError(
            f"第一个书签从第 {starts[0][0] + 1} 页开始而不是第 1 页；"
            "开头存在不属于任何书签的页面，为避免丢内容已停止。"
        )
    if any(page < 0 or page >= total_pages for page, _ in starts):
        raise ValueError("存在超出 PDF 页数范围的书签，已停止。")
    if len({page for page, _ in starts}) != len(starts):
        raise ValueError("多个书签指向同一页，边界有歧义，已停止。")

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest: list[dict[str, object]] = []
    for index, (start, title) in enumerate(starts):
        end = starts[index + 1][0] if index + 1 < len(starts) else total_pages
        writer = PdfWriter()
        for page_number in range(start, end):
            writer.add_page(reader.pages[page_number])
        copy_metadata(reader, writer)
        name = f"{index + 1:02d}_{safe_filename(title)}.pdf"
        with (output_dir / name).open("wb") as fh:
            writer.write(fh)
        manifest.append({"file": name, "title": title, "start_page": start + 1,
                         "end_page": end, "pages": end - start})

    copied = sum(int(m["pages"]) for m in manifest)
    if copied != total_pages:
        raise RuntimeError(f"页数校验失败：输出 {copied} 页，原文件 {total_pages} 页。")
    return manifest


def cleanup_old_jobs() -> None:
    now = time.time()
    if not WORK_ROOT.exists():
        return
    for job in WORK_ROOT.iterdir():
        try:
            if now - job.stat().st_mtime > TTL_SECONDS:
                shutil.rmtree(job, ignore_errors=True)
        except OSError:
            pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # 精简日志
        print(f"[pdfsplit] {self.address_string()} {fmt % args}")

    # ── helpers ──────────────────────────────────────────────
    def _json(self, code: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _fail(self, code: int, message: str) -> None:
        self._json(code, {"error": message})

    # ── routes ───────────────────────────────────────────────
    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            body = INDEX_HTML.encode()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path.startswith("/api/dl/"):
            self._serve_zip(parsed.path.removeprefix("/api/dl/"))
            return
        self._fail(HTTPStatus.NOT_FOUND, "not found")

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/api/upload":
            self._fail(HTTPStatus.NOT_FOUND, "not found")
            return

        query = parse_qs(parsed.query)
        raw_name = (query.get("name") or ["document"])[0]
        base = re.sub(r"\.pdf$", "", raw_name, flags=re.IGNORECASE)
        base = re.sub(r"[^\w\u4e00-\u9fff-]+", "_", base).strip("._") or "document"
        base = base[:80]

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._fail(HTTPStatus.BAD_REQUEST, "缺少请求体")
            return
        if length > MAX_UPLOAD:
            self._fail(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "文件超过 512MB")
            return

        token = secrets.token_urlsafe(16)
        job = WORK_ROOT / token
        job.mkdir(parents=True, exist_ok=True)
        try:
            src = job / "input.pdf"
            with src.open("wb") as fh:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(1 << 20, remaining))
                    if not chunk:
                        raise ValueError("客户端中断上传")
                    fh.write(chunk)
                    remaining -= len(chunk)
                # 魔数校验：不是 PDF 直接拒绝
                head = src.open("rb").read(5)
                if head != b"%PDF-":
                    self._fail(HTTPStatus.BAD_REQUEST, "不是有效的 PDF 文件")
                    return

            manifest = split_pdf(src, job / "parts")

            zip_path = job / "result.zip"
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                for item in manifest:
                    zf.write(job / "parts" / str(item["file"]), arcname=str(item["file"]))
                # 清单一并放进 zip，便于留档
                zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

            self._json(HTTPStatus.OK, {
                "token": token,
                "download": f"api/dl/{token}",
                "zipName": f"{base}_split.zip",
                "parts": len(manifest),
                "manifest": manifest,
            })
        except ValueError as exc:
            shutil.rmtree(job, ignore_errors=True)
            self._fail(HTTPStatus.BAD_REQUEST, str(exc))
        except Exception as exc:  # noqa: BLE001
            shutil.rmtree(job, ignore_errors=True)
            print(f"[pdfsplit] 处理失败: {exc!r}")
            self._fail(HTTPStatus.INTERNAL_SERVER_ERROR, f"处理失败：{exc}")
        finally:
            threading.Thread(target=cleanup_old_jobs, daemon=True).start()

    def _serve_zip(self, token: str) -> None:
        if not re.fullmatch(r"[A-Za-z0-9_-]{20,40}", token or ""):
            self._fail(HTTPStatus.BAD_REQUEST, "token 非法")
            return
        zip_path = WORK_ROOT / token / "result.zip"
        if not zip_path.is_file():
            self._fail(HTTPStatus.NOT_FOUND, "下载已过期（保留 2 小时），请重新上传")
            return
        data = zip_path.read_bytes()
        # zipName 由前端 a.download 提供；这里给一个安全兜底
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", 'attachment; filename="split.zip"')
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    cleanup_old_jobs()
    server = ThreadingHTTPServer(("127.0.0.1", 8790), Handler)
    print("[pdfsplit] listening on 127.0.0.1:8790")
    server.serve_forever()


if __name__ == "__main__":
    main()
