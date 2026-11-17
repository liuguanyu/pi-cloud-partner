-- blob 需要记住 mime：手机端用 <img src> 直接渲染，靠 Content-Type 决定是否当图片
ALTER TABLE blobs ADD COLUMN mime VARCHAR(128) NOT NULL DEFAULT '' AFTER kind;
-- 也记住原始文件名，便于手机端展示与下载时命名
ALTER TABLE blobs ADD COLUMN name VARCHAR(255) NOT NULL DEFAULT '' AFTER mime;
