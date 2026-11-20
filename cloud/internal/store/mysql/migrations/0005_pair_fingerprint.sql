-- 认领时的浏览器环境指纹（SHA-256，64 hex）。
-- 用途：同一台手机（同环境）重新配对时免回 Mac 点批准（自动 takeover）。
-- 不依赖手机端存储：指纹每次打开页面都能重算，iOS 清 localStorage 也不影响。
ALTER TABLE pairs ADD COLUMN claim_fingerprint CHAR(64) NOT NULL DEFAULT '' AFTER claim_ip;
