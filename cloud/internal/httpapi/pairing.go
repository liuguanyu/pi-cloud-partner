package httpapi

import (
	"net/http"

	"github.com/leon82/pcp/cloud/internal/auth"
	"github.com/leon82/pcp/cloud/internal/model"
	"github.com/leon82/pcp/cloud/internal/pairing"
	"github.com/leon82/pcp/cloud/internal/protocol"
)

type claimBody struct {
	Code       string `json:"code"`
	DeviceName string `json:"deviceName"`
	Platform   string `json:"platform"`
	// ClaimantID 由手机生成并持久化，用于 claim 幂等与抢码判定。
	// 手机不再需要登录，所以这是唯一能区分"同一台手机重试"的标识。
	ClaimantID string `json:"claimantId"`
}

type approveBody struct {
	PairID   string `json:"pairId"`
	Decision string `json:"decision"` // approve | reject
	Takeover bool   `json:"takeover"`
}

type revokeBody struct {
	PairID string `json:"pairId"`
	Reason string `json:"reason"`
}

type sessionBody struct {
	PairID string `json:"pairId"`
}

// handlePairRequest：PC 生成配对码。云只登记，不授权。
func (s *Server) handlePairRequest(w http.ResponseWriter, r *http.Request) {
	dev, err := s.requireDevice(r)
	if err != nil {
		s.fail(w, err)
		return
	}
	res, err := s.cfg.Pairing.Request(r.Context(), dev.ID, model.ID{})
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"code":      res.Code,
		"expiresAt": res.ExpiresAt,
		// 扫码用的完整 URL，手机端可直接生成二维码
		"claimUrl": "/m?code=" + res.Code,
	})
}

// handlePairClaim：手机认领配对码。码只把手机带进「待批列表」，不产生权限。
func (s *Server) handlePairClaim(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if !s.limiter.allow("claim:"+ip, s.cfg.Now()) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "尝试过于频繁，请稍后再试")
		return
	}

	var body claimBody
	if err := decode(r, &body); err != nil {
		s.fail(w, err)
		return
	}
	normalized := pairing.NormalizeCode(body.Code)
	// 每码最多 5 次失败尝试，防撞库
	if !s.limiter.allow("code:"+normalized, s.cfg.Now()) {
		_ = s.cfg.Store.PairCodeDelete(r.Context(), normalized)
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "该配对码尝试次数过多，已作废")
		return
	}

	res, err := s.cfg.Pairing.Claim(r.Context(), pairing.ClaimInput{
		Code:       body.Code,
		ClaimantID: body.ClaimantID,
		IP:         ip,
		DeviceName: body.DeviceName,
	})
	if err != nil {
		s.fail(w, err)
		return
	}

	// 立刻通知 PC：有人申请接管
	if pc, err := s.cfg.Store.PairByID(r.Context(), mustRef(res.PairID)); err == nil {
		env, _ := protocol.New(protocol.TypeUIRequest, s.cfg.Now()).WithPayload(map[string]any{
			"kind":       "pair_approval",
			"pairId":     res.PairID,
			"deviceName": body.DeviceName,
			"platform":   body.Platform,
			"claimIp":    ip,
		})
		env.PairID = res.PairID
		_ = s.cfg.Hub.Send(pc.DeviceID, env)
	}

	writeJSON(w, http.StatusOK, res)
}

// handlePairApprove：**唯一的授权动作**，只能由 device 凭据发起。
func (s *Server) handlePairApprove(w http.ResponseWriter, r *http.Request) {
	dev, err := s.requireDevice(r)
	if err != nil {
		s.fail(w, err)
		return
	}
	var body approveBody
	if err := decode(r, &body); err != nil {
		s.fail(w, err)
		return
	}
	pairID, err := protocol.ParseRef(body.PairID, "p")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "pairId 格式非法")
		return
	}

	if body.Decision == "reject" {
		if err := s.cfg.Pairing.Reject(r.Context(), dev.ID, pairID); err != nil {
			s.fail(w, err)
			return
		}
		s.publishPairEvent(pairID, protocol.TypePairRejected, nil)
		writeJSON(w, http.StatusOK, map[string]string{"pairId": body.PairID, "status": "rejected"})
		return
	}

	res, err := s.cfg.Pairing.Approve(r.Context(), dev.ID, pairID, body.Takeover)
	if err != nil {
		s.fail(w, err)
		return
	}
	// 让已连着的手机立刻知道通过了（手机也可能在轮询 /pair/current）
	s.publishPairEvent(pairID, protocol.TypePairApproved, map[string]any{
		"pairId":   res.PairID,
		"takeover": res.Takeover,
	})
	writeJSON(w, http.StatusOK, res)
}

// handlePairReject 保留为显式端点，与 approve 的 decision=reject 等价。
func (s *Server) handlePairReject(w http.ResponseWriter, r *http.Request) {
	dev, err := s.requireDevice(r)
	if err != nil {
		s.fail(w, err)
		return
	}
	var body revokeBody
	if err := decode(r, &body); err != nil {
		s.fail(w, err)
		return
	}
	pairID, err := protocol.ParseRef(body.PairID, "p")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "pairId 格式非法")
		return
	}
	if err := s.cfg.Pairing.Reject(r.Context(), dev.ID, pairID); err != nil {
		s.fail(w, err)
		return
	}
	s.publishPairEvent(pairID, protocol.TypePairRejected, nil)
	writeJSON(w, http.StatusOK, map[string]string{"status": "rejected"})
}

// handlePairRevoke：任一方都能单方面断开（fail-safe）。
func (s *Server) handlePairRevoke(w http.ResponseWriter, r *http.Request) {
	var body revokeBody
	if err := decode(r, &body); err != nil {
		s.fail(w, err)
		return
	}
	pairID, err := protocol.ParseRef(body.PairID, "p")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "pairId 格式非法")
		return
	}

	// 先试 device 凭据，再试手机 user 凭据
	if dev, derr := s.requireDevice(r); derr == nil {
		if err := s.cfg.Pairing.Revoke(r.Context(), pairID, "device", dev.ID); err != nil {
			s.fail(w, err)
			return
		}
	} else if plain, ok := authBearer(r); ok {
		// 手机：既接受 refreshToken（L1 常态），也接受 user 凭据（将来有登录时）
		tok, terr := s.cfg.Store.TokenByHash(r.Context(), auth.Hash(plain))
		if terr != nil || tok.Revoked() || tok.Expired(s.cfg.Now()) {
			s.fail(w, errUnauthorized)
			return
		}
		switch tok.Kind {
		case model.TokenRefresh:
			if tok.SubjectID != pairID {
				s.fail(w, errUnauthorized)
				return
			}
			if err := s.cfg.Pairing.Revoke(r.Context(), pairID, "mobile", model.ID{}); err != nil {
				s.fail(w, err)
				return
			}
		case model.TokenUser:
			if err := s.cfg.Pairing.Revoke(r.Context(), pairID, "mobile", tok.SubjectID); err != nil {
				s.fail(w, err)
				return
			}
		default:
			s.fail(w, errUnauthorized)
			return
		}
	} else {
		s.fail(w, errUnauthorized)
		return
	}

	s.publishPairEvent(pairID, protocol.TypePairRevoked, map[string]any{"reason": body.Reason})
	writeJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}

// handlePairCurrent 给两端做状态查询：手机轮询此处等待 approve。
func (s *Server) handlePairCurrent(w http.ResponseWriter, r *http.Request) {
	if dev, err := s.requireDevice(r); err == nil {
		pairs, _ := s.cfg.Store.PairsByDevice(r.Context(), dev.ID)
		writeJSON(w, http.StatusOK, map[string]any{
			"device": map[string]any{
				"deviceId": dev.ID.String(),
				"name":     dev.Name,
				"online":   s.cfg.Hub.Online(dev.ID),
			},
			"pairs": s.pairViews(r, pairs),
		})
		return
	}

	// 手机端：用 refreshToken 查自己这个 pair 的状态（L1 没有用户登录）
	if plain, ok := authBearer(r); ok {
		tok, err := s.cfg.Store.TokenByHash(r.Context(), auth.Hash(plain))
		if err == nil && !tok.Revoked() && !tok.Expired(s.cfg.Now()) {
			if tok.Kind == model.TokenRefresh {
				pair, err := s.cfg.Store.PairByID(r.Context(), tok.SubjectID)
				if err == nil {
					writeJSON(w, http.StatusOK, map[string]any{"pairs": s.pairViews(r, []model.Pair{pair})})
					return
				}
			}
			if tok.Kind == model.TokenUser {
				pairs, _ := s.cfg.Store.PairsByUser(r.Context(), tok.SubjectID)
				writeJSON(w, http.StatusOK, map[string]any{"pairs": s.pairViews(r, pairs)})
				return
			}
		}
	}
	s.fail(w, errUnauthorized)
}

// handleSession：refreshToken 换 12h pairToken（幂等，可反复换）。
func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	plain, ok := authBearer(r)
	if !ok {
		s.fail(w, errUnauthorized)
		return
	}
	var body sessionBody
	if err := decode(r, &body); err != nil {
		s.fail(w, err)
		return
	}
	pairID, err := protocol.ParseRef(body.PairID, "p")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "pairId 格式非法")
		return
	}
	token, expires, err := s.cfg.Pairing.Session(r.Context(), plain, pairID)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"pairToken": token,
		"expiresAt": expires,
	})
}

func authBearer(r *http.Request) (string, bool) {
	return auth.BearerToken(r.Header.Get("Authorization"))
}

func (s *Server) publishPairEvent(pairID model.ID, frameType string, payload any) {
	env, err := protocol.New(frameType, s.cfg.Now()).WithPayload(payload)
	if err != nil {
		return
	}
	s.cfg.Hub.Publish(pairID, env, protocol.Marshal)
}

func (s *Server) pairViews(r *http.Request, pairs []model.Pair) []map[string]any {
	out := make([]map[string]any, 0, len(pairs))
	for _, p := range pairs {
		view := map[string]any{
			"pairId":    protocol.RefPair(p.ID),
			"status":    string(p.Status),
			"createdAt": p.CreatedAt,
		}
		if p.ApprovedAt != nil {
			view["approvedAt"] = *p.ApprovedAt
		}
		if p.RevokedAt != nil {
			view["revokedAt"] = *p.RevokedAt
		}
		if p.RevokedBy != "" {
			view["revokedBy"] = p.RevokedBy
		}
		if p.ClaimIP != "" {
			view["claimIp"] = p.ClaimIP
		}
		if dev, err := s.cfg.Store.DeviceByID(r.Context(), p.DeviceID); err == nil {
			view["device"] = map[string]any{
				"deviceId": dev.ID.String(),
				"name":     dev.Name,
				"online":   s.cfg.Hub.Online(dev.ID),
			}
		}
		if user, err := s.cfg.Store.UserByID(r.Context(), p.UserID); err == nil {
			view["user"] = map[string]any{
				"userId":      user.ID.String(),
				"displayName": user.DisplayName,
			}
		}
		out = append(out, view)
	}
	return out
}

func mustRef(ref string) model.ID {
	id, err := protocol.ParseRef(ref, "p")
	if err != nil {
		return model.ID{}
	}
	return id
}
