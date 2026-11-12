-- 历史回看的定位键：sessionId 对应 pi 写的 JSONL 文件名后缀。
-- 云端只存这个 id，正文仍在 bridge 磁盘（见 SPEC D6）。
ALTER TABLE tasks ADD COLUMN session_id VARCHAR(64) NOT NULL DEFAULT '' AFTER title;
