-- L1 配对：手机不再需要登录凭据，改由 PC 侧批准时用设备持有者身份代签。
-- 于是 claim 阶段需要一个"认领者标识"来做幂等/抢码判定（原来是靠 user_id）。
ALTER TABLE pairs ADD COLUMN claimant_id VARCHAR(64) NOT NULL DEFAULT '' AFTER user_id;
-- 记录来源 IP，供 PC 端在批准时判断是不是自己那台手机
ALTER TABLE pairs ADD COLUMN claim_ip VARCHAR(45) NOT NULL DEFAULT '' AFTER claimant_id;
-- 设备归属：approve 时若 pair 还没有用户，就用它
ALTER TABLE devices ADD COLUMN owner_user_id BINARY(16) NULL AFTER fingerprint;
