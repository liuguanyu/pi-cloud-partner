// Package mysql 是生产版 Store 实现。
//
// DDL 见 migrations/0001_init.sql，可由 `pcpd migrate` 应用。
// 语义与 memory 实现保持一致（尤其是「一台 device 最多一个 active pair」的唯一约束）。
package mysql

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"

	"github.com/leon82/pcp/cloud/internal/model"
	"github.com/leon82/pcp/cloud/internal/store"
)

//go:embed migrations/*.sql
var migrations embed.FS

type Store struct {
	db *sql.DB
}

// Open 建立连接池。dsn 形如：
//
//	pcp:pass@tcp(127.0.0.1:3306)/pcp?parseTime=false&charset=utf8mb4&multiStatements=true
func Open(dsn string) (*Store, error) {
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(16)
	db.SetMaxIdleConns(8)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("连接 MySQL 失败: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Migrate 应用内置 DDL。
//
// 用 schema_migrations 表记录已应用的版本，**每个文件只跑一次**。
// 早期版本是「每次启动全量重跑」，依赖 CREATE TABLE IF NOT EXISTS 保持幂等；
// 一旦出现 `ALTER TABLE ... ADD COLUMN` 就会在第二次启动时报
// `Duplicate column name` 并导致服务崩溃重启 —— 这里改为版本化。
func (s *Store) Migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx,
		`CREATE TABLE IF NOT EXISTS schema_migrations (
		   version    VARCHAR(255) NOT NULL,
		   applied_at BIGINT       NOT NULL,
		   PRIMARY KEY (version)
		 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
		return fmt.Errorf("创建 schema_migrations 失败: %w", err)
	}

	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)

	for _, name := range names {
		var exists int
		if err := s.db.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, name).Scan(&exists); err != nil {
			return err
		}
		if exists > 0 {
			continue
		}

		raw, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		for _, stmt := range splitStatements(string(raw)) {
			if _, err := s.db.ExecContext(ctx, stmt); err != nil {
				// 1060 = 列已存在，1061 = 索引已存在。
				// 发生在「版本表引入之前就手工执行过该迁移」的库上，视为已应用。
				if isDupColumnOrKey(err) {
					continue
				}
				return fmt.Errorf("%s: %w", name, err)
			}
		}
		if _, err := s.db.ExecContext(ctx,
			`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
			name, time.Now().UnixMilli()); err != nil {
			return err
		}
	}
	return nil
}

func isDupColumnOrKey(err error) bool {
	var me *mysql.MySQLError
	if !errors.As(err, &me) {
		return false
	}
	return me.Number == 1060 || me.Number == 1061
}

// splitStatements 按分号切分，忽略注释行。DDL 里没有字符串内分号，够用。
func splitStatements(sqlText string) []string {
	var out []string
	var buf strings.Builder
	for _, line := range strings.Split(sqlText, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "--") {
			continue
		}
		buf.WriteString(line)
		buf.WriteString("\n")
		if strings.HasSuffix(trimmed, ";") {
			stmt := strings.TrimSpace(buf.String())
			stmt = strings.TrimSuffix(stmt, ";")
			if stmt != "" {
				out = append(out, stmt)
			}
			buf.Reset()
		}
	}
	if stmt := strings.TrimSpace(buf.String()); stmt != "" {
		out = append(out, stmt)
	}
	return out
}

func isDup(err error) bool {
	var me *mysql.MySQLError
	return errors.As(err, &me) && me.Number == 1062
}

func wrap(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return store.ErrNotFound
	}
	if isDup(err) {
		return store.ErrConflict
	}
	return err
}

func nullInt(v *int64) any {
	if v == nil {
		return nil
	}
	return *v
}

func toPtr(v sql.NullInt64) *int64 {
	if !v.Valid {
		return nil
	}
	out := v.Int64
	return &out
}

// ── 用户 ──────────────────────────────────────────────────────

func (s *Store) UpsertUser(ctx context.Context, ssoSub, displayName string, now int64) (model.User, error) {
	id := model.NewID()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO users (id, sso_sub, display_name, created_at) VALUES (?,?,?,?)
		 ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
		id[:], nullable(ssoSub), displayName, now)
	if err != nil {
		return model.User{}, wrap(err)
	}
	return s.userBySub(ctx, ssoSub)
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (s *Store) userBySub(ctx context.Context, ssoSub string) (model.User, error) {
	var (
		u         model.User
		rawID     []byte
		dbSub     sql.NullString
		dbName    sql.NullString
		createdAt int64
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT id, sso_sub, display_name, created_at FROM users WHERE sso_sub = ?`, nullable(ssoSub)).
		Scan(&rawID, &dbSub, &dbName, &createdAt)
	if err != nil {
		return model.User{}, wrap(err)
	}
	copy(u.ID[:], rawID)
	u.SSOSub = dbSub.String
	u.DisplayName = dbName.String
	u.CreatedAt = createdAt
	return u, nil
}

func (s *Store) UserByID(ctx context.Context, id model.ID) (model.User, error) {
	var (
		u         model.User
		rawID     []byte
		dbSub     sql.NullString
		dbName    sql.NullString
		createdAt int64
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT id, sso_sub, display_name, created_at FROM users WHERE id = ?`, id[:]).
		Scan(&rawID, &dbSub, &dbName, &createdAt)
	if err != nil {
		return model.User{}, wrap(err)
	}
	copy(u.ID[:], rawID)
	u.SSOSub = dbSub.String
	u.DisplayName = dbName.String
	u.CreatedAt = createdAt
	return u, nil
}

// ── 设备 ──────────────────────────────────────────────────────

func (s *Store) CreateDevice(ctx context.Context, d model.Device) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO devices (id, name, fingerprint, owner_user_id, last_seen_at, created_at) VALUES (?,?,?,?,?,?)`,
		d.ID[:], d.Name, d.Fingerprint, nullableIDPtr(d.OwnerUserID), nullInt(d.LastSeenAt), d.CreatedAt)
	return wrap(err)
}

func (s *Store) DeviceByID(ctx context.Context, id model.ID) (model.Device, error) {
	var (
		d        model.Device
		rawID    []byte
		lastSeen sql.NullInt64
	)
	var owner []byte
	err := s.db.QueryRowContext(ctx,
		`SELECT id, name, fingerprint, owner_user_id, last_seen_at, created_at FROM devices WHERE id = ?`, id[:]).
		Scan(&rawID, &d.Name, &d.Fingerprint, &owner, &lastSeen, &d.CreatedAt)
	if err != nil {
		return model.Device{}, wrap(err)
	}
	copy(d.ID[:], rawID)
	if len(owner) == 16 {
		ownerID := model.ID{}
		copy(ownerID[:], owner)
		d.OwnerUserID = &ownerID
	}
	d.LastSeenAt = toPtr(lastSeen)
	return d, nil
}

func (s *Store) SetDeviceOwner(ctx context.Context, id, ownerID model.ID) error {
	_, err := s.db.ExecContext(ctx, `UPDATE devices SET owner_user_id = ? WHERE id = ?`, ownerID[:], id[:])
	return wrap(err)
}

func (s *Store) TouchDevice(ctx context.Context, id model.ID, now int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE devices SET last_seen_at = ? WHERE id = ?`, now, id[:])
	return wrap(err)
}

// ── 凭据 ──────────────────────────────────────────────────────

func (s *Store) CreateToken(ctx context.Context, t model.Token) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO tokens (id, kind, subject_id, hash, created_at, expires_at, last_used_at, revoked_at)
		 VALUES (?,?,?,?,?,?,?,?)`,
		t.ID[:], string(t.Kind), t.SubjectID[:], t.Hash, t.CreatedAt,
		nullInt(t.ExpiresAt), nullInt(t.LastUsedAt), nullInt(t.RevokedAt))
	return wrap(err)
}

func (s *Store) TokenByHash(ctx context.Context, hash string) (model.Token, error) {
	var (
		t                      model.Token
		rawID, rawSub          []byte
		kind                   string
		expires, lastUsed, rev sql.NullInt64
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT id, kind, subject_id, hash, created_at, expires_at, last_used_at, revoked_at
		 FROM tokens WHERE hash = ?`, hash).
		Scan(&rawID, &kind, &rawSub, &t.Hash, &t.CreatedAt, &expires, &lastUsed, &rev)
	if err != nil {
		return model.Token{}, wrap(err)
	}
	copy(t.ID[:], rawID)
	copy(t.SubjectID[:], rawSub)
	t.Kind = model.TokenKind(kind)
	t.ExpiresAt = toPtr(expires)
	t.LastUsedAt = toPtr(lastUsed)
	t.RevokedAt = toPtr(rev)
	return t, nil
}

func (s *Store) TouchToken(ctx context.Context, id model.ID, now int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE tokens SET last_used_at = ? WHERE id = ?`, now, id[:])
	return wrap(err)
}

func (s *Store) RevokeToken(ctx context.Context, id model.ID, now int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, now, id[:])
	return wrap(err)
}

func (s *Store) RevokeTokensForPair(ctx context.Context, pairID model.ID, kinds []model.TokenKind, now int64) error {
	if len(kinds) == 0 {
		return nil
	}
	placeholders := strings.Repeat("?,", len(kinds))
	placeholders = strings.TrimSuffix(placeholders, ",")
	args := make([]any, 0, len(kinds)+2)
	args = append(args, now, pairID[:])
	for _, k := range kinds {
		args = append(args, string(k))
	}
	_, err := s.db.ExecContext(ctx,
		`UPDATE tokens SET revoked_at = ?
		 WHERE revoked_at IS NULL AND subject_id = ? AND kind IN (`+placeholders+`)`, args...)
	return wrap(err)
}

// ── 配对码 ────────────────────────────────────────────────────

func (s *Store) CreatePairCode(ctx context.Context, c model.PairCode) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO pair_codes (code, device_id, user_id, pair_id, expires_at) VALUES (?,?,?,?,?)`,
		c.Code, c.DeviceID[:], nullableID(c.UserID), c.PairID[:], c.ExpiresAt)
	return wrap(err)
}

func nullableIDPtr(id *model.ID) any {
	if id == nil || id.IsZero() {
		return nil
	}
	return id[:]
}

func nullableID(id model.ID) any {
	if id.IsZero() {
		return nil
	}
	return id[:]
}

func (s *Store) PairCodeGet(ctx context.Context, code string) (model.PairCode, error) {
	var (
		c       model.PairCode
		rawDev  []byte
		rawUser []byte
		rawPair []byte
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT code, device_id, user_id, pair_id, expires_at FROM pair_codes WHERE code = ?`, code).
		Scan(&c.Code, &rawDev, &rawUser, &rawPair, &c.ExpiresAt)
	if err != nil {
		return model.PairCode{}, wrap(err)
	}
	copy(c.DeviceID[:], rawDev)
	copy(c.PairID[:], rawPair)
	if len(rawUser) == 16 {
		copy(c.UserID[:], rawUser)
	}
	return c, nil
}

func (s *Store) PairCodeByPair(ctx context.Context, pairID model.ID) (model.PairCode, error) {
	var (
		c       model.PairCode
		rawDev  []byte
		rawUser []byte
		rawPair []byte
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT code, device_id, user_id, pair_id, expires_at FROM pair_codes
		 WHERE pair_id = ? ORDER BY expires_at DESC LIMIT 1`, pairID[:]).
		Scan(&c.Code, &rawDev, &rawUser, &rawPair, &c.ExpiresAt)
	if err != nil {
		return model.PairCode{}, wrap(err)
	}
	copy(c.DeviceID[:], rawDev)
	copy(c.PairID[:], rawPair)
	if len(rawUser) == 16 {
		copy(c.UserID[:], rawUser)
	}
	return c, nil
}

func (s *Store) PairCodeDelete(ctx context.Context, code string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM pair_codes WHERE code = ?`, code)
	return wrap(err)
}

// ── pair ──────────────────────────────────────────────────────

func (s *Store) CreatePair(ctx context.Context, p model.Pair) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO pairs (id, device_id, user_id, claimant_id, claim_ip, status, created_at, approved_at, revoked_at, revoked_by)
		 VALUES (?,?,?,?,?,?,?,?,?,NULL)`,
		p.ID[:], p.DeviceID[:], nullableID(p.UserID), p.ClaimantID, p.ClaimIP, string(p.Status), p.CreatedAt,
		nullInt(p.ApprovedAt), nullInt(p.RevokedAt))
	return wrap(err)
}

func (s *Store) scanPair(row interface{ Scan(...any) error }) (model.Pair, error) {
	var (
		p                    model.Pair
		rawID, rawDev, rawUs []byte
		claimantID, claimIP  string
		status               string
		approved, revoked    sql.NullInt64
		revokedBy            sql.NullString
	)
	err := row.Scan(&rawID, &rawDev, &rawUs, &claimantID, &claimIP, &status, &p.CreatedAt, &approved, &revoked, &revokedBy)
	if err != nil {
		return model.Pair{}, wrap(err)
	}
	copy(p.ID[:], rawID)
	copy(p.DeviceID[:], rawDev)
	if len(rawUs) == 16 {
		copy(p.UserID[:], rawUs)
	}
	p.ClaimantID = claimantID
	p.ClaimIP = claimIP
	p.Status = model.PairStatus(status)
	p.ApprovedAt = toPtr(approved)
	p.RevokedAt = toPtr(revoked)
	p.RevokedBy = revokedBy.String
	return p, nil
}

const pairColumns = `id, device_id, user_id, claimant_id, claim_ip, status, created_at, approved_at, revoked_at, revoked_by`

func (s *Store) PairByID(ctx context.Context, id model.ID) (model.Pair, error) {
	return s.scanPair(s.db.QueryRowContext(ctx, `SELECT `+pairColumns+` FROM pairs WHERE id = ?`, id[:]))
}

func (s *Store) ActivePairByDevice(ctx context.Context, deviceID model.ID) (*model.Pair, error) {
	p, err := s.scanPair(s.db.QueryRowContext(ctx,
		`SELECT `+pairColumns+` FROM pairs WHERE device_id = ? AND status = 'active' LIMIT 1`, deviceID[:]))
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *Store) queryPairs(ctx context.Context, query string, arg any) ([]model.Pair, error) {
	rows, err := s.db.QueryContext(ctx, query, arg)
	if err != nil {
		return nil, wrap(err)
	}
	defer rows.Close()

	out := make([]model.Pair, 0, 8)
	for rows.Next() {
		p, err := s.scanPair(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, wrap(rows.Err())
}

func (s *Store) PairsByUser(ctx context.Context, userID model.ID) ([]model.Pair, error) {
	return s.queryPairs(ctx, `SELECT `+pairColumns+` FROM pairs WHERE user_id = ? ORDER BY created_at DESC`, userID[:])
}

func (s *Store) PairsByDevice(ctx context.Context, deviceID model.ID) ([]model.Pair, error) {
	return s.queryPairs(ctx, `SELECT `+pairColumns+` FROM pairs WHERE device_id = ? ORDER BY created_at DESC`, deviceID[:])
}

func (s *Store) SetPairStatus(ctx context.Context, id model.ID, status model.PairStatus, now int64, revokedBy model.RevokedBy) error {
	var (
		approved any
		revoked  any
		revBy    any
	)
	if status == model.PairActive {
		approved = now
	}
	switch status {
	case model.PairRevoked, model.PairRejected, model.PairExpired:
		revoked = now
		if revokedBy != "" {
			revBy = string(revokedBy)
		}
	}
	// COALESCE 保证只写有值的列（例如 requested → pending_approval 不动 approved_at）
	_, err := s.db.ExecContext(ctx,
		`UPDATE pairs SET status = ?,
		   approved_at = COALESCE(?, approved_at),
		   revoked_at  = COALESCE(?, revoked_at),
		   revoked_by  = COALESCE(?, revoked_by)
		 WHERE id = ?`,
		string(status), approved, revoked, revBy, id[:])
	return wrap(err)
}

func (s *Store) SetPairUser(ctx context.Context, id, userID model.ID) error {
	_, err := s.db.ExecContext(ctx, `UPDATE pairs SET user_id = ? WHERE id = ?`, userID[:], id[:])
	return wrap(err)
}

// ── 审计 ──────────────────────────────────────────────────────

func (s *Store) SetPairClaimant(ctx context.Context, id model.ID, claimantID, ip string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE pairs SET claimant_id = ?, claim_ip = ? WHERE id = ?`, claimantID, ip, id[:])
	return wrap(err)
}

func (s *Store) AppendAudit(ctx context.Context, e model.AuditEvent) error {
	var pairID, deviceID, taskID any
	if e.PairID != nil {
		pairID = e.PairID[:]
	}
	if e.DeviceID != nil {
		deviceID = e.DeviceID[:]
	}
	if e.TaskID != nil {
		taskID = e.TaskID[:]
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO audit_events (ts, actor, action, pair_id, device_id, task_id, ip, ua, meta)
		 VALUES (?,?,?,?,?,?,?,?,?)`,
		e.TS, e.Actor, e.Action, pairID, deviceID, taskID, nullable(e.IP), nullable(e.UA), nullable(e.Meta))
	return wrap(err)
}

func (s *Store) ListAudit(ctx context.Context, pairID model.ID, limit int) ([]model.AuditEvent, error) {
	query := `SELECT id, ts, actor, action, pair_id, device_id, task_id, ip, ua, meta FROM audit_events`
	args := []any{}
	if !pairID.IsZero() {
		query += ` WHERE pair_id = ?`
		args = append(args, pairID[:])
	}
	query += ` ORDER BY ts DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, wrap(err)
	}
	defer rows.Close()

	out := make([]model.AuditEvent, 0, limit)
	for rows.Next() {
		var (
			e                       model.AuditEvent
			rawPair, rawDev, rawTsk []byte
			ip, ua, meta            sql.NullString
		)
		if err := rows.Scan(&e.ID, &e.TS, &e.Actor, &e.Action, &rawPair, &rawDev, &rawTsk, &ip, &ua, &meta); err != nil {
			return nil, wrap(err)
		}
		if len(rawPair) == 16 {
			id := model.ID{}
			copy(id[:], rawPair)
			e.PairID = &id
		}
		if len(rawDev) == 16 {
			id := model.ID{}
			copy(id[:], rawDev)
			e.DeviceID = &id
		}
		if len(rawTsk) == 16 {
			id := model.ID{}
			copy(id[:], rawTsk)
			e.TaskID = &id
		}
		e.IP = ip.String
		e.UA = ua.String
		e.Meta = meta.String
		out = append(out, e)
	}
	return out, wrap(rows.Err())
}

// ── 任务摘要 ──────────────────────────────────────────────────

// UpsertTask 是部分更新：空字符串 / NULL 不覆盖已有值。
func (s *Store) UpsertTask(ctx context.Context, t model.Task) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO tasks (id, pair_id, workspace, workspace_mode, status, title, session_id,
		                    started_at, settled_at, exit_reason, blob_count)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?)
		 ON DUPLICATE KEY UPDATE
		   workspace      = IF(VALUES(workspace) = '',      workspace,      VALUES(workspace)),
		   workspace_mode = IF(VALUES(workspace_mode) = '', workspace_mode, VALUES(workspace_mode)),
		   status         = IF(VALUES(status) = '',         status,         VALUES(status)),
		   title          = IF(VALUES(title) = '',          title,          VALUES(title)),
		   session_id     = IF(VALUES(session_id) = '',     session_id,     VALUES(session_id)),
		   started_at     = COALESCE(VALUES(started_at), started_at),
		   settled_at     = COALESCE(VALUES(settled_at), settled_at),
		   exit_reason    = IF(VALUES(exit_reason) = '',    exit_reason,    VALUES(exit_reason)),
		   blob_count     = IF(VALUES(blob_count) = 0,      blob_count,     VALUES(blob_count))`,
		t.ID[:], t.PairID[:], t.Workspace, modeOrShared(t.WorkspaceMode), t.Status, t.Title, t.SessionID,
		nullInt(t.StartedAt), nullInt(t.SettledAt), t.ExitReason, t.BlobCount)
	return wrap(err)
}

func modeOrShared(mode string) string {
	if mode == "" {
		return "shared"
	}
	return mode
}

func (s *Store) TaskByID(ctx context.Context, id model.ID) (model.Task, error) {
	var (
		t                model.Task
		rawID, rawPair   []byte
		mode             string
		started, settled sql.NullInt64
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT id, pair_id, workspace, workspace_mode, status, title, session_id,
		        started_at, settled_at, exit_reason, blob_count
		 FROM tasks WHERE id = ?`, id[:]).
		Scan(&rawID, &rawPair, &t.Workspace, &mode, &t.Status, &t.Title, &t.SessionID,
			&started, &settled, &t.ExitReason, &t.BlobCount)
	if err != nil {
		return model.Task{}, wrap(err)
	}
	copy(t.ID[:], rawID)
	copy(t.PairID[:], rawPair)
	t.WorkspaceMode = mode
	t.StartedAt = toPtr(started)
	t.SettledAt = toPtr(settled)
	return t, nil
}

func (s *Store) TasksByPair(ctx context.Context, pairID model.ID, limit int) ([]model.Task, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, pair_id, workspace, workspace_mode, status, title, session_id,
		        started_at, settled_at, exit_reason, blob_count
		 FROM tasks WHERE pair_id = ? ORDER BY COALESCE(started_at, 0) DESC LIMIT ?`,
		pairID[:], limit)
	if err != nil {
		return nil, wrap(err)
	}
	defer rows.Close()

	out := make([]model.Task, 0, limit)
	for rows.Next() {
		var (
			t                model.Task
			rawID, rawPair   []byte
			mode             string
			started, settled sql.NullInt64
		)
		if err := rows.Scan(&rawID, &rawPair, &t.Workspace, &mode, &t.Status, &t.Title, &t.SessionID,
			&started, &settled, &t.ExitReason, &t.BlobCount); err != nil {
			return nil, wrap(err)
		}
		copy(t.ID[:], rawID)
		copy(t.PairID[:], rawPair)
		t.WorkspaceMode = mode
		t.StartedAt = toPtr(started)
		t.SettledAt = toPtr(settled)
		out = append(out, t)
	}
	return out, wrap(rows.Err())
}

// ── blob 元数据 ──────────────────────────────────────────────

func (s *Store) CreateBlob(ctx context.Context, b model.Blob) error {
	var taskID any
	if b.TaskID != nil {
		taskID = b.TaskID[:]
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO blobs (id, task_id, pair_id, kind, mime, name, bytes, sha256, storage_key, created_at, expires_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		b.ID[:], taskID, b.PairID[:], b.Kind, b.Mime, b.Name, b.Bytes, b.SHA256, b.StorageKey, b.CreatedAt, b.ExpiresAt)
	return wrap(err)
}

func (s *Store) scanBlob(row interface{ Scan(...any) error }) (model.Blob, error) {
	var (
		b       model.Blob
		rawID   []byte
		rawTask []byte
		rawPair []byte
	)
	err := row.Scan(&rawID, &rawTask, &rawPair, &b.Kind, &b.Mime, &b.Name, &b.Bytes, &b.SHA256, &b.StorageKey, &b.CreatedAt, &b.ExpiresAt)
	if err != nil {
		return model.Blob{}, wrap(err)
	}
	copy(b.ID[:], rawID)
	copy(b.PairID[:], rawPair)
	if len(rawTask) == 16 {
		id := model.ID{}
		copy(id[:], rawTask)
		b.TaskID = &id
	}
	return b, nil
}

const blobColumns = `id, task_id, pair_id, kind, mime, name, bytes, sha256, storage_key, created_at, expires_at`

func (s *Store) BlobByID(ctx context.Context, id model.ID) (model.Blob, error) {
	return s.scanBlob(s.db.QueryRowContext(ctx, `SELECT `+blobColumns+` FROM blobs WHERE id = ?`, id[:]))
}

func (s *Store) BlobBySHA(ctx context.Context, sha string) (model.Blob, error) {
	return s.scanBlob(s.db.QueryRowContext(ctx, `SELECT `+blobColumns+` FROM blobs WHERE sha256 = ?`, sha))
}
