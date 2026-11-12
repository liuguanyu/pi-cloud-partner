// Package model 定义云端持久化的领域对象。
//
// 约定（与 SPEC.md §6 一致）：
//   - 时间一律 unix 毫秒 int64，不用 time.Time 传输
//   - 主键为 16 字节 uuid 的二进制形式，DB 里存 BINARY(16)
package model

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
)

// ID 是 16 字节的 uuid。
type ID [16]byte

// NewID 生成随机 uuid（v4 布局）。
func NewID() ID {
	var id ID
	if _, err := rand.Read(id[:]); err != nil {
		panic("cloud: entropy source unavailable: " + err.Error())
	}
	id[6] = (id[6] & 0x0f) | 0x40 // version 4
	id[8] = (id[8] & 0x3f) | 0x80 // variant RFC4122
	return id
}

// String 返回 32 位小写十六进制。
func (id ID) String() string { return hex.EncodeToString(id[:]) }

// IsZero 判断是否为全零 ID。
func (id ID) IsZero() bool { return id == ID{} }

// ParseID 解析 32 位十六进制。
func ParseID(s string) (ID, error) {
	var id ID
	if len(s) != 32 {
		return id, fmt.Errorf("id 长度应为 32 个十六进制字符，实际 %d", len(s))
	}
	raw, err := hex.DecodeString(s)
	if err != nil {
		return id, errors.New("id 不是合法十六进制")
	}
	copy(id[:], raw)
	return id, nil
}

// Short 返回对外展示用的短标识：p_/t_ 前缀 + 16 位十六进制。
// 与 protocol/schema/envelope.json 的 pattern `^(p|t)_[0-9a-f]{8,32}$` 对齐。
func (id ID) Short(prefix string) string { return prefix + "_" + hex.EncodeToString(id[:8]) }

// ParseShort 解析短标识（p_xxx / t_xxx）。
// 只保留 8 字节信息，因此不能用于 DB 主键查找；云端映射表负责展开。
func ParseShort(s, prefix string) (string, error) {
	want := prefix + "_"
	if len(s) != len(want)+16 || s[:len(want)] != want {
		return "", fmt.Errorf("非法短标识 %q，期望 %s<16位十六进制>", s, want)
	}
	if _, err := hex.DecodeString(s[len(want):]); err != nil {
		return "", fmt.Errorf("非法短标识 %q", s)
	}
	return s[len(want):], nil
}

// PairStatus 与 protocol/pairing.md §2 状态机一致。
type PairStatus string

const (
	PairRequested       PairStatus = "requested"
	PairPendingApproval PairStatus = "pending_approval"
	PairActive          PairStatus = "active"
	PairSuspended       PairStatus = "suspended"
	PairRevoked         PairStatus = "revoked"
	PairRejected        PairStatus = "rejected"
	PairExpired         PairStatus = "expired"
)

// RevokedBy 记录撤销来源。
type RevokedBy string

const (
	RevokedByMobile RevokedBy = "mobile"
	RevokedByDevice RevokedBy = "device"
	RevokedByAdmin  RevokedBy = "admin"
	RevokedBySystem RevokedBy = "system"
)

// TokenKind 区分凭据类型。
type TokenKind string

const (
	// TokenDevice 是 PC 侧长期凭据，落盘 ~/.pi/bridge/credentials.json
	TokenDevice TokenKind = "device"
	// TokenRefresh 是手机侧长期凭据
	TokenRefresh TokenKind = "refresh"
	// TokenPair 是 12h 短期凭据，用于 SSE 与上行 API
	TokenPair TokenKind = "pair"
	// TokenUser 是手机侧登录凭据（M1 用长期 token 代替 SSO），仅用于 claim
	TokenUser TokenKind = "user"
)

type User struct {
	ID          ID
	SSOSub      string
	DisplayName string
	CreatedAt   int64
}

type Device struct {
	ID          ID
	Name        string
	Fingerprint string
	LastSeenAt  *int64
	CreatedAt   int64
}

type Pair struct {
	ID         ID
	DeviceID   ID
	UserID     ID
	Status     PairStatus
	CreatedAt  int64
	ApprovedAt *int64
	RevokedAt  *int64
	RevokedBy  string
}

// Token 只存哈希，明文仅在签发那一刻返回一次。
type Token struct {
	ID         ID
	Kind       TokenKind
	SubjectID  ID
	Hash       string
	CreatedAt  int64
	ExpiresAt  *int64
	LastUsedAt *int64
	RevokedAt  *int64
}

func (t Token) Expired(now int64) bool { return t.ExpiresAt != nil && now >= *t.ExpiresAt }
func (t Token) Revoked() bool          { return t.RevokedAt != nil }

// PairCode 是短 TTL 的一次性配对码，与 pair 记录分开存放，避免过期码污染 pairs。
type PairCode struct {
	Code      string
	DeviceID  ID
	UserID    ID
	PairID    ID
	ExpiresAt int64
}

type AuditEvent struct {
	ID       uint64
	TS       int64
	Actor    string // mobile | device | admin | system
	Action   string // pair.claimed / task.started / ...
	PairID   *ID
	DeviceID *ID
	TaskID   *ID
	IP       string
	UA       string
	Meta     string // JSON
}

// Task 是云端只保存的「摘要」，不含任何会话正文。
type Task struct {
	ID            ID
	PairID        ID
	Workspace     string
	WorkspaceMode string
	Status        string
	Title         string // 用户 /name 命名优先，否则派生弱标题
	// SessionID 是 pi 的会话 id，历史回看时由 bridge 用它定位 JSONL 文件
	SessionID  string
	StartedAt  *int64
	SettledAt  *int64
	ExitReason string
	BlobCount  int
}
