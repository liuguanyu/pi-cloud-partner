-- pi-cloud-partner 云端库（MySQL 8）
-- 设计约束（见 SPEC.md §6）：
--   * 时间一律 BIGINT unix 毫秒，不用 DATETIME（避开时区与驱动解析差异）
--   * 字符集 utf8mb4；主键 BINARY(16) uuid
--   * audit_events 只追加，不给 UPDATE/DELETE
--   * 会话正文永不入库：本库只有元数据与任务摘要

CREATE TABLE IF NOT EXISTS users (
    id           BINARY(16)   NOT NULL,
    sso_sub      VARCHAR(191) NULL,
    display_name VARCHAR(128) NULL,
    created_at   BIGINT       NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_sso_sub (sso_sub)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- device 故意不带 user_id：同一台机器先后被不同人配对是正常的，归属由 pairs 表达
CREATE TABLE IF NOT EXISTS devices (
    id           BINARY(16)   NOT NULL,
    name         VARCHAR(128) NOT NULL,
    fingerprint  CHAR(64)     NOT NULL,
    last_seen_at BIGINT       NULL,
    created_at   BIGINT       NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_fingerprint (fingerprint)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pairs (
    id               BINARY(16) NOT NULL,
    device_id        BINARY(16) NOT NULL,
    -- claim 之前还不知道是哪台手机，允许 NULL（SetPairUser 在 claim 时补上）
    user_id          BINARY(16) NULL,
    status           ENUM('requested','pending_approval','active','suspended',
                          'revoked','rejected','expired') NOT NULL,
    created_at       BIGINT     NOT NULL,
    approved_at      BIGINT     NULL,
    revoked_at       BIGINT     NULL,
    revoked_by       ENUM('mobile','device','admin','system') NULL,
    -- 生成列 + 唯一索引 = 「一台 device 最多一个 active pair」由数据库兜底。
    -- MySQL 不支持部分唯一索引，用 NULL 不参与唯一约束的特性绕过。
    active_device_id BINARY(16) AS (IF(status = 'active', device_id, NULL)) VIRTUAL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_active_pair (active_device_id),
    KEY idx_device_status (device_id, status),
    KEY idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 配对码独立成表：短 TTL、一次性，避免过期码污染 pairs
CREATE TABLE IF NOT EXISTS pair_codes (
    code       CHAR(6)    NOT NULL,
    device_id  BINARY(16) NOT NULL,
    user_id    BINARY(16) NULL,
    pair_id    BINARY(16) NOT NULL,
    expires_at BIGINT     NOT NULL,
    PRIMARY KEY (code),
    KEY idx_pair (pair_id),
    KEY idx_expire (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 只存 sha256 十六进制，明文仅在签发时返回一次
CREATE TABLE IF NOT EXISTS tokens (
    id           BINARY(16) NOT NULL,
    kind         ENUM('device','refresh','pair','user') NOT NULL,
    subject_id   BINARY(16) NOT NULL,
    hash         CHAR(64)   NOT NULL,
    created_at   BIGINT     NOT NULL,
    expires_at   BIGINT     NULL,
    last_used_at BIGINT     NULL,
    revoked_at   BIGINT     NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_hash (hash),
    KEY idx_subject (subject_id, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_events (
    id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    ts        BIGINT     NOT NULL,
    actor     ENUM('mobile','device','admin','system') NOT NULL,
    action    VARCHAR(48) NOT NULL,
    pair_id   BINARY(16) NULL,
    device_id BINARY(16) NULL,
    task_id   BINARY(16) NULL,
    ip        VARCHAR(45) NULL,
    ua        VARCHAR(255) NULL,
    meta      JSON NULL,
    PRIMARY KEY (id),
    KEY idx_ts (ts),
    KEY idx_pair (pair_id, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 任务摘要：title 是唯一可能含用户输入的字段，且只含用户主动 /name 的那个短字符串
CREATE TABLE IF NOT EXISTS tasks (
    id             BINARY(16)   NOT NULL,
    pair_id        BINARY(16)   NOT NULL,
    workspace      VARCHAR(512) NOT NULL DEFAULT '',
    workspace_mode ENUM('shared','worktree') NOT NULL DEFAULT 'shared',
    status         VARCHAR(24)  NOT NULL DEFAULT '',
    title          VARCHAR(80)  NOT NULL DEFAULT '',
    started_at     BIGINT NULL,
    settled_at     BIGINT NULL,
    exit_reason    VARCHAR(24) NOT NULL DEFAULT '',
    blob_count     INT NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    KEY idx_pair_time (pair_id, started_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS blobs (
    id          BINARY(16)   NOT NULL,
    task_id     BINARY(16)   NULL,
    pair_id     BINARY(16)   NOT NULL,
    kind        VARCHAR(24)  NOT NULL,
    bytes       BIGINT       NOT NULL,
    sha256      CHAR(64)     NOT NULL,
    storage_key VARCHAR(512) NOT NULL,
    created_at  BIGINT       NOT NULL,
    expires_at  BIGINT       NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_sha (sha256),
    KEY idx_expire (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
