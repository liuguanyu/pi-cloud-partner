// Package store 定义持久化接口。
//
// 两套实现：
//   - store/memory  本地开发与单元测试，进程内即可跑通配对全流程
//   - store/mysql   生产实现，DDL 见 store/mysql/migrations
//
// 接口只表达「云端权威元数据」：账号、设备、pair、token 哈希、审计、任务摘要。
// 会话正文永不经过这里（见 SPEC.md D6）。
package store

import (
	"context"
	"errors"

	"github.com/leon82/pcp/cloud/internal/model"
)

// ErrNotFound 统一表示记录不存在，避免上层判断驱动错误码。
var ErrNotFound = errors.New("not found")

// ErrConflict 表示唯一约束冲突（例如同一 device 已存在 active pair）。
var ErrConflict = errors.New("conflict")

type Store interface {
	// ── 用户 ──────────────────────────────────────────────
	// UpsertUser 按 ssoSub 幂等创建用户。
	UpsertUser(ctx context.Context, ssoSub, displayName string, now int64) (model.User, error)
	UserByID(ctx context.Context, id model.ID) (model.User, error)

	// ── 设备 ──────────────────────────────────────────────
	CreateDevice(ctx context.Context, d model.Device) error
	DeviceByID(ctx context.Context, id model.ID) (model.Device, error)
	TouchDevice(ctx context.Context, id model.ID, now int64) error
	// SetDeviceOwner 绑定设备主人（L1：首次 approve 时自动绑定）
	SetDeviceOwner(ctx context.Context, id, ownerID model.ID) error

	// ── 凭据 ──────────────────────────────────────────────
	CreateToken(ctx context.Context, t model.Token) error
	TokenByHash(ctx context.Context, hash string) (model.Token, error)
	TouchToken(ctx context.Context, id model.ID, now int64) error
	RevokeToken(ctx context.Context, id model.ID, now int64) error
	// RevokeTokensForPair 撤销某 pair 下某类凭据（例如 revoke pair 时清掉 pair/refresh token）。
	RevokeTokensForPair(ctx context.Context, pairID model.ID, kinds []model.TokenKind, now int64) error

	// ── 配对码 ────────────────────────────────────────────
	CreatePairCode(ctx context.Context, c model.PairCode) error
	PairCodeGet(ctx context.Context, code string) (model.PairCode, error)
	// PairCodeByPair 用于 approve 后清理该 pair 的码，以及 request 的幂等判定
	PairCodeByPair(ctx context.Context, pairID model.ID) (model.PairCode, error)
	PairCodeDelete(ctx context.Context, code string) error

	// ── pair ──────────────────────────────────────────────
	CreatePair(ctx context.Context, p model.Pair) error
	PairByID(ctx context.Context, id model.ID) (model.Pair, error)
	ActivePairByDevice(ctx context.Context, deviceID model.ID) (*model.Pair, error)
	PairsByUser(ctx context.Context, userID model.ID) ([]model.Pair, error)
	PairsByDevice(ctx context.Context, deviceID model.ID) ([]model.Pair, error)
	SetPairStatus(ctx context.Context, id model.ID, status model.PairStatus, now int64, revokedBy model.RevokedBy) error
	// SetPairUser 在 approve 时把设备主人绑定到 pair
	SetPairUser(ctx context.Context, id, userID model.ID) error
	// SetPairClaimant 记录认领者标识与来源 IP（claim 阶段，此时还没有用户身份）
	SetPairClaimant(ctx context.Context, id model.ID, claimantID, ip string) error

	// ── 审计（append-only） ────────────────────────────────
	AppendAudit(ctx context.Context, e model.AuditEvent) error
	ListAudit(ctx context.Context, pairID model.ID, limit int) ([]model.AuditEvent, error)

	// ── blob 元数据（二进制不进库） ────────────────────────
	CreateBlob(ctx context.Context, b model.Blob) error
	BlobByID(ctx context.Context, id model.ID) (model.Blob, error)
	BlobBySHA(ctx context.Context, sha256 string) (model.Blob, error)

	// ── 任务摘要（不含正文） ───────────────────────────────
	// UpsertTask 是**部分更新**：零值字段不覆盖已存在的值。
	// 云端在不同事件里只知道一部分信息（enqueued 有 workspace，settled 有 exitReason），
	// 用整行覆盖会把先前写入的字段抹掉。
	UpsertTask(ctx context.Context, t model.Task) error
	TaskByID(ctx context.Context, id model.ID) (model.Task, error)
	TasksByPair(ctx context.Context, pairID model.ID, limit int) ([]model.Task, error)

	Close() error
}
