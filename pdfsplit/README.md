# pdfsplit —— 按书签分割 PDF 的小站

https://lab.leon82.com/pdfsplit/

上传带书签（outline）的 PDF → 按每个书签的起始页切成独立 PDF → 打包 zip 下载。

## 保证

- **不丢内容**：分割逻辑与本地验证脚本（`~/devspace/pdf/split_pdf_by_bookmarks.py`）一致——
  首个书签必须从第 1 页开始（否则拒绝，避免开头有"无主"页面）、书签去重按页排序、
  同页多书签视为歧义拒绝、输出页数与原文件严格守恒校验
- **忠实原 PDF**：逐页复制（`pypdf` page-level copy），不渲染、不重排、不 OCR，
  矢量内容原样保留；原文件元数据（metadata）一并复制
- 命名：`NN_书签标题.pdf`；zip 内附带 `manifest.json`（每个分片的页码范围）

## 架构

```
手机/PC 浏览器
   │ POST /pdfsplit/api/upload?name=xxx.pdf（原始字节，非 multipart）
   ▼
nginx  location ^~ /pdfsplit/   ← 前缀匹配优先于正则，与 /api、/sse 等互不影响
   │   client_max_body_size 512m（仅此路径，不抬高全局 64m）
   ▼
127.0.0.1:8790  pdfsplit.service（systemd DynamicUser 沙箱）
   │   pypdf 分割（页数守恒校验）→ zip → /var/lib/pdfsplit/<token>/result.zip
   ▼
GET /pdfsplit/api/dl/<token>   下载（2 小时后自动清理）
```

- 分割逻辑与本地验证脚本一致：首个书签必须从第 1 页开始、同页歧义拒绝、
  输出页数与原文件严格守恒校验；逐页复制不渲染，忠实原 PDF
- nginx `^~ /pdfsplit/` 前缀路由，location 内 512m 上限只对本路径生效
- systemd 沙箱：DynamicUser + ProtectSystem=strict + StateDirectory=/var/lib/pdfsplit
- 产物保留 2 小时自动清理；token 为 32 字符随机串，路径穿越不可能

## 文件

- `server.py` —— 单文件服务（stdlib + pypdf），上传页内嵌
