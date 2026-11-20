// Package pairing 实现 protocol/pairing.md 的三方配对协议。
//
// 权责铁律（不要在 Handler 里绕过它）：
//   - 云只能**登记**，不能批准。Approve 必须由 device 凭据发起（即 PC 本地的那个人）。
//   - 配对码只用于 claim，不承载任何权限。
//   - 一个 device 同时最多一个 active pair（DB 唯一索引兜底）。
package pairing

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/leon82/pcp/cloud/internal/auth"
	"github.com/leon82/pcp/cloud/internal/model"
	"github.com/leon82/pcp/cloud/internal/store"
)

// 领域错误，由 HTTP 层翻译成状态码。
var (
	ErrCodeNotFound   = errors.New("code_not_found")
	ErrAlreadyClaimed = errors.New("already_claimed")
	ErrDeviceBusy     = errors.New("device_busy")
	ErrPairNotActive  = errors.New("pair_not_active")
	ErrUnauthorized   = errors.New("unauthorized")
	ErrTakeoverNeeded = errors.New("takeover_required")
	ErrSelfClaim      = errors.New("self_claim")
)

// Config 汇聚所有 TTL，方便测试压缩时间。
type Config struct {
	CodeTTL       time.Duration // 配对码有效期，默认 120s
	PairTokenTTL  time.Duration // 12h
	RefreshTTL    time.Duration // 长期，默认 90 天
	SuspendGrace  time.Duration // bridge 心跳丢失后的宽限，默认 10min（M1 仅记录，不自动改状态）
	TakeoverByDev bool          // 是否允许 approve 时顶替已有 active pair，默认 true
}

func DefaultConfig() Config {
	return Config{
		CodeTTL:       120 * time.Second,
		PairTokenTTL:  12 * time.Hour,
		RefreshTTL:    90 * 24 * time.Hour,
		SuspendGrace:  10 * time.Minute,
		TakeoverByDev: true,
	}
}

// Service 是无状态的配对逻辑，时间由 now 注入以便测试。
type Service struct {
	store store.Store
	cfg   Config
	now   func() int64
}

func New(st store.Store, cfg Config) *Service {
	if cfg.CodeTTL == 0 {
		cfg = DefaultConfig()
	}
	return &Service{store: st, cfg: cfg, now: func() int64 { return time.Now().UnixMilli() }}
}

// SetClock 仅供测试注入时钟。
func (s *Service) SetClock(now func() int64) { s.now = now }

// ── 编码：6 位 Crockford Base32，去掉易混字符 0/O/1/I/L ──────────────
const codeAlphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ"

func newCode() string {
	buf := make([]byte, 6)
	if _, err := rand.Read(buf); err != nil {
		panic("cloud: entropy source unavailable: " + err.Error())
	}
	out := make([]byte, 6)
	for i, b := range buf {
		out[i] = codeAlphabet[int(b)%len(codeAlphabet)]
	}
	return string(out)
}

// NormalizeCode 让用户输入的码容错：大小写、空格、连字符、易混字符。
func NormalizeCode(in string) string {
	repl := strings.NewReplacer("-", "", " ", "", "O", "0", "I", "1", "L", "1")
	up := strings.ToUpper(repl.Replace(strings.TrimSpace(in)))
	return up
}

// ── 结果结构 ───────────────────────────────────────────────────

type RequestResult struct {
	Code      string `json:"code"`
	ExpiresAt int64  `json:"expiresAt"`
}

type ClaimResult struct {
	PairID       string `json:"pairId"`
	Status       string `json:"status"`
	RefreshToken string `json:"refreshToken"`
	ExpiresAt    int64  `json:"refreshExpiresAt"`
}

type ApproveResult struct {
	PairID   string `json:"pairId"`
	Status   string `json:"status"`
	Takeover bool   `json:"takeover,omitempty"`
}

// ── 协议步骤 ───────────────────────────────────────────────────

// Request 由 PC 发起：生成一次性配对码，并创建 requested 状态的 pair 占位。
func (s *Service) Request(ctx context.Context, deviceID, userID model.ID) (RequestResult, error) {
	now := s.now()

	// 幂等：同一 device 若已有未过期的码，直接返回，避免重复点「生成配对码」刷屏
	if existing, err := s.store.PairsByDevice(ctx, deviceID); err == nil {
		for _, p := range existing {
			if p.Status != model.PairRequested {
				continue
			}
			if c, err := s.store.PairCodeByPair(ctx, p.ID); err == nil && c.ExpiresAt > now {
				return RequestResult{Code: c.Code, ExpiresAt: c.ExpiresAt}, nil
			}
		}
	}

	pair := model.Pair{
		ID:        model.NewID(),
		DeviceID:  deviceID,
		UserID:    userID,
		Status:    model.PairRequested,
		CreatedAt: now,
	}
	if err := s.store.CreatePair(ctx, pair); err != nil {
		return RequestResult{}, err
	}

	// 碰撞极低但要处理：重试若干次
	for attempt := 0; attempt < 5; attempt++ {
		code := newCode()
		expires := now + s.cfg.CodeTTL.Milliseconds()
		err := s.store.CreatePairCode(ctx, model.PairCode{
			Code:      code,
			DeviceID:  deviceID,
			UserID:    userID,
			PairID:    pair.ID,
			ExpiresAt: expires,
		})
		if err == nil {
			s.audit(ctx, "pair.requested", "device", &deviceID, &pair.ID, now)
			return RequestResult{Code: code, ExpiresAt: expires}, nil
		}
		if !errors.Is(err, store.ErrConflict) {
			return RequestResult{}, err
		}
	}
	return RequestResult{}, errors.New("无法分配唯一的配对码，请重试")
}

// Claim 由手机发起：把手机身份挂到码上，状态 → pending_approval。
//
// 硬拒绝规则（protocol/pairing.md §3.2）：
//   - 码被别的手机抢过 → ErrAlreadyClaimed，不做覆盖，同时记 pair.contested 审计
//   - device 已有 active pair 且未启用顶替 → ErrDeviceBusy
//
// ClaimInput 是认领所需的全部输入。
//
// L1 起手机**不需要登录**：认领者身份由手机自己生成的 claimantId 表示，
// 真正的授权仍然只在 PC 侧的 Approve 那一下。claimantId 只用于
// 「同一台手机重试是幂等的」与「别的手机来抢码要拒绝」。
type ClaimInput struct {
	Code       string
	ClaimantID string
	IP         string
	DeviceName string
	// Fingerprint 是手机浏览器环境指纹（SHA-256 hex）。
	// 与历史 pair 的指纹比对用于"同机重配对免人工批准"。不参与抢码判定。
	Fingerprint string
}

func (s *Service) Claim(ctx context.Context, in ClaimInput) (ClaimResult, error) {
	code := in.Code
	claimant := strings.TrimSpace(in.ClaimantID)
	now := s.now()
	normalized := NormalizeCode(code)

	pc, err := s.store.PairCodeGet(ctx, normalized)
	if err != nil {
		return ClaimResult{}, ErrCodeNotFound
	}
	if now >= pc.ExpiresAt {
		_ = s.store.PairCodeDelete(ctx, normalized)
		return ClaimResult{}, ErrCodeNotFound
	}

	pair, err := s.store.PairByID(ctx, pc.PairID)
	if err != nil {
		return ClaimResult{}, ErrCodeNotFound
	}

	switch pair.Status {
	case model.PairRequested:
		// 首次认领：记录认领者标识、来源 IP 与环境指纹（批准时给 PC 端看）
		if err := s.store.SetPairClaimant(ctx, pair.ID, claimant, in.IP, in.Fingerprint); err != nil {
			return ClaimResult{}, err
		}
		pair.ClaimantID = claimant
		pair.ClaimIP = in.IP
	case model.PairPendingApproval:
		// 同一台手机重复 claim 幂等（弱网重试）；换一台手机就是抢码
		if pair.ClaimantID != claimant {
			s.audit(ctx, "pair.contested", "system", &pair.DeviceID, &pair.ID, now)
			return ClaimResult{}, ErrAlreadyClaimed
		}
		refresh, expires, err := s.issueRefresh(ctx, pair.ID, now)
		if err != nil {
			return ClaimResult{}, err
		}
		return ClaimResult{PairID: fmtPair(pair.ID), Status: string(pair.Status), RefreshToken: refresh, ExpiresAt: expires}, nil
	default:
		return ClaimResult{}, ErrCodeNotFound
	}

	// device 已有 active pair：M1 直接判定 device_busy，approve 时可带 takeover 覆盖
	if active, err := s.store.ActivePairByDevice(ctx, pair.DeviceID); err == nil && active.ID != pair.ID {
		if !s.cfg.TakeoverByDev {
			return ClaimResult{}, ErrDeviceBusy
		}
	}

	if err := s.store.SetPairStatus(ctx, pair.ID, model.PairPendingApproval, now, ""); err != nil {
		return ClaimResult{}, err
	}
	refresh, expires, err := s.issueRefresh(ctx, pair.ID, now)
	if err != nil {
		return ClaimResult{}, err
	}
	s.audit(ctx, "pair.claimed", "mobile", &pair.DeviceID, &pair.ID, now)
	return ClaimResult{PairID: fmtPair(pair.ID), Status: string(model.PairPendingApproval), RefreshToken: refresh, ExpiresAt: expires}, nil
}

// Approve 由 PC 发起，是**唯一**的常规授权动作。
func (s *Service) Approve(ctx context.Context, deviceID model.ID, pairID model.ID, takeover bool) (ApproveResult, error) {
	return s.approve(ctx, deviceID, pairID, takeover, "device", "")
}

// ApproveBySystem 供"同机重配对免人工批准"使用：
// 当 claim 携带的浏览器环境指纹与该 device 最近 30 天内 pair 过的指纹完全一致时，
// 视为主人自己的手机（凭据被系统清掉后重新配对），云端代为批准。
// 调用方（HTTP 层）必须先完成指纹匹配与时间窗校验。
func (s *Service) ApproveBySystem(ctx context.Context, deviceID model.ID, pairID model.ID) (ApproveResult, error) {
	return s.approve(ctx, deviceID, pairID, true, "system", `{"reason":"auto_approve","method":"fingerprint"}`)
}

func (s *Service) approve(ctx context.Context, deviceID model.ID, pairID model.ID, takeover bool, actor, meta string) (ApproveResult, error) {
	now := s.now()
	pair, err := s.store.PairByID(ctx, pairID)
	if err != nil {
		return ApproveResult{}, ErrCodeNotFound
	}
	if pair.DeviceID != deviceID {
		return ApproveResult{}, ErrUnauthorized
	}
	if pair.Status != model.PairPendingApproval {
		return ApproveResult{}, fmt.Errorf("pair 状态为 %s，无法批准", pair.Status)
	}

	// L1：手机没登录，pair 上还没有用户 → 用设备主人的身份代签
	if pair.UserID.IsZero() {
		ownerID, err := s.resolveDeviceOwner(ctx, deviceID, now)
		if err != nil {
			return ApproveResult{}, err
		}
		if err := s.store.SetPairUser(ctx, pairID, ownerID); err != nil {
			return ApproveResult{}, err
		}
	}

	var replaced bool
	if active, err := s.store.ActivePairByDevice(ctx, deviceID); err == nil && active.ID != pairID {
		if !takeover {
			return ApproveResult{Takeover: true}, ErrTakeoverNeeded
		}
		if err := s.store.SetPairStatus(ctx, active.ID, model.PairRevoked, now, model.RevokedBySystem); err != nil {
			return ApproveResult{}, err
		}
		_ = s.store.RevokeTokensForPair(ctx, active.ID, []model.TokenKind{model.TokenRefresh, model.TokenPair}, now)
		s.audit(ctx, "pair.revoked", "system", &deviceID, &active.ID, now)
		replaced = true
	}

	if err := s.store.SetPairStatus(ctx, pairID, model.PairActive, now, ""); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return ApproveResult{}, ErrDeviceBusy
		}
		return ApproveResult{}, err
	}
	// 码是一次性的：批准后立刻作废，避免重复 claim
	if c, err := s.store.PairCodeByPair(ctx, pairID); err == nil {
		_ = s.store.PairCodeDelete(ctx, c.Code)
	}
	s.auditMeta(ctx, "pair.approved", actor, meta, &deviceID, &pairID, now)
	if replaced {
		s.auditMeta(ctx, "pair.takeover", actor, meta, &deviceID, &pairID, now)
	}
	return ApproveResult{PairID: fmtPair(pairID), Status: string(model.PairActive), Takeover: replaced}, nil
}

// Reject 由 PC 发起。
func (s *Service) Reject(ctx context.Context, deviceID, pairID model.ID) error {
	now := s.now()
	pair, err := s.store.PairByID(ctx, pairID)
	if err != nil {
		return ErrCodeNotFound
	}
	if pair.DeviceID != deviceID {
		return ErrUnauthorized
	}
	if err := s.store.SetPairStatus(ctx, pairID, model.PairRejected, now, model.RevokedByDevice); err != nil {
		return err
	}
	_ = s.store.RevokeTokensForPair(ctx, pairID, []model.TokenKind{model.TokenRefresh, model.TokenPair}, now)
	s.audit(ctx, "pair.rejected", "device", &deviceID, &pairID, now)
	return nil
}

// Revoke 任一方都能单方面断开（fail-safe）。
func (s *Service) Revoke(ctx context.Context, pairID model.ID, actor string, actorID model.ID) error {
	now := s.now()
	pair, err := s.store.PairByID(ctx, pairID)
	if err != nil {
		return ErrCodeNotFound
	}
	if actor == "device" && pair.DeviceID != actorID {
		return ErrUnauthorized
	}
	// actorID 为零表示调用方已用「持有该 pair 的 refreshToken」证明过归属（L1 常态）
	if actor == "mobile" && !actorID.IsZero() && pair.UserID != actorID {
		return ErrUnauthorized
	}
	revokedBy := model.RevokedByMobile
	if actor == "device" {
		revokedBy = model.RevokedByDevice
	}
	if err := s.store.SetPairStatus(ctx, pairID, model.PairRevoked, now, revokedBy); err != nil {
		return err
	}
	_ = s.store.RevokeTokensForPair(ctx, pairID, []model.TokenKind{model.TokenRefresh, model.TokenPair}, now)
	s.audit(ctx, "pair.revoked", actor, &pair.DeviceID, &pairID, now)
	return nil
}

// Session 用 refreshToken 换 12h 的 pairToken（幂等，可反复调用）。
func (s *Service) Session(ctx context.Context, refreshToken string, pairID model.ID) (pairToken string, expiresAt int64, err error) {
	now := s.now()
	tok, err := s.store.TokenByHash(ctx, auth.Hash(refreshToken))
	if err != nil {
		return "", 0, ErrUnauthorized
	}
	if tok.Kind != model.TokenRefresh || tok.Revoked() || tok.Expired(now) || tok.SubjectID != pairID {
		return "", 0, ErrUnauthorized
	}
	pair, err := s.store.PairByID(ctx, pairID)
	if err != nil {
		return "", 0, ErrUnauthorized
	}
	if pair.Status != model.PairActive && pair.Status != model.PairSuspended {
		return "", 0, ErrPairNotActive
	}

	plain, hash := auth.NewToken()
	expires := now + s.cfg.PairTokenTTL.Milliseconds()
	if err := s.store.CreateToken(ctx, model.Token{
		ID:        model.NewID(),
		Kind:      model.TokenPair,
		SubjectID: pairID,
		Hash:      hash,
		CreatedAt: now,
		ExpiresAt: &expires,
	}); err != nil {
		return "", 0, err
	}
	_ = s.store.TouchToken(ctx, tok.ID, now)
	return plain, expires, nil
}

func (s *Service) issueRefresh(ctx context.Context, pairID model.ID, now int64) (string, int64, error) {
	plain, hash := auth.NewToken()
	expires := now + s.cfg.RefreshTTL.Milliseconds()
	err := s.store.CreateToken(ctx, model.Token{
		ID:        model.NewID(),
		Kind:      model.TokenRefresh,
		SubjectID: pairID,
		Hash:      hash,
		CreatedAt: now,
		ExpiresAt: &expires,
	})
	if err != nil {
		return "", 0, err
	}
	return plain, expires, nil
}

// resolveDeviceOwner 取设备主人；没有就创建并绑定。
//
// L1 的语义是「这台机器的主人，就是能在这台机器上点『允许』的人」，
// 所以设备主人在首次批准时确定，不需要额外的登录流程。
func (s *Service) resolveDeviceOwner(ctx context.Context, deviceID model.ID, now int64) (model.ID, error) {
	device, err := s.store.DeviceByID(ctx, deviceID)
	if err != nil {
		return model.ID{}, err
	}
	if device.OwnerUserID != nil && !device.OwnerUserID.IsZero() {
		return *device.OwnerUserID, nil
	}
	user, err := s.store.UpsertUser(ctx, "device:"+device.ID.String(), device.Name, now)
	if err != nil {
		return model.ID{}, err
	}
	if err := s.store.SetDeviceOwner(ctx, device.ID, user.ID); err != nil {
		return model.ID{}, err
	}
	return user.ID, nil
}

func (s *Service) audit(ctx context.Context, action, actor string, deviceID, pairID *model.ID, now int64) {
	s.auditMeta(ctx, action, actor, "", deviceID, pairID, now)
}

func (s *Service) auditMeta(ctx context.Context, action, actor, meta string, deviceID, pairID *model.ID, now int64) {
	if err := s.store.AppendAudit(ctx, model.AuditEvent{
		TS:       now,
		Actor:    actor,
		Action:   action,
		PairID:   pairID,
		DeviceID: deviceID,
		Meta:     meta,
	}); err != nil {
		fmt.Fprintf(os.Stderr, "audit 写入失败（不阻塞主流程）: action=%s err=%v\n", action, err)
	}
}

func fmtPair(id model.ID) string { return "p_" + id.String() }
