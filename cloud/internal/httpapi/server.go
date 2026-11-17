// Package httpapi 是云端的 HTTP/SSE/WebSocket 入口。
//
// 端点分组（与 protocol/pairing.md、control.md 对齐）：
//
//	配对    POST /pair/request   /pair/claim   /pair/approve   /pair/reject   /pair/revoke
//	        GET  /pair/current
//	会话    POST /api/session                      refreshToken → pairToken(12h)
//	上行    POST /api/task/start  /api/task/{id}/input  /api/task/{id}/cancel
//	        POST /api/task/focus  /api/control      /api/ui/respond
//	        GET  /api/tasks
//	下行    GET  /sse                             手机多路复用事件流
//	桥接    GET  /ws/bridge                       bridge 长连接（WSS）
//	运维    GET  /healthz
package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/leon82/pcp/cloud/internal/auth"
	"github.com/leon82/pcp/cloud/internal/hub"
	"github.com/leon82/pcp/cloud/internal/model"
	"github.com/leon82/pcp/cloud/internal/pairing"
	"github.com/leon82/pcp/cloud/internal/protocol"
	"github.com/leon82/pcp/cloud/internal/store"
)

// Config 是 Server 的依赖集合。
type Config struct {
	Store   store.Store
	Pairing *pairing.Service
	Hub     *hub.Hub
	Log     *slog.Logger
	Now     func() int64
	// AllowedOrigins 为空表示不限制（本地开发）；生产应填 https://lab.leon82.com
	AllowedOrigins []string
	// BlobDir 是二进制落盘目录；为空表示禁用 blob 功能
	BlobDir string
	// BlobSecret 用于给 blob 链接签名（浏览器 <img> 带不了 Authorization）
	BlobSecret string
}

type Server struct {
	cfg     Config
	mux     *http.ServeMux
	limiter *rateLimiter
	// bootID 每次进程启动随机生成。seq 是进程内计数，重启会归零，
	// 客户端据此判断「本地游标是否已经过期」。
	bootID string
	// blobDir / blobSecret 供 blob 上传与签名链接使用
	blobDir    string
	blobSecret string
}

func New(cfg Config) *Server {
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if cfg.Now == nil {
		cfg.Now = func() int64 { return time.Now().UnixMilli() }
	}
	boot := make([]byte, 8)
	if _, err := rand.Read(boot); err != nil {
		panic("cloud: entropy source unavailable: " + err.Error())
	}
	s := &Server{
		cfg:        cfg,
		mux:        http.NewServeMux(),
		limiter:    newRateLimiter(10, time.Minute),
		bootID:     hex.EncodeToString(boot),
		blobDir:    cfg.BlobDir,
		blobSecret: cfg.BlobSecret,
	}
	s.routes()
	return s
}

// Handler 返回挂好中间件的完整 handler。
func (s *Server) Handler() http.Handler { return s.middleware(s.mux) }

func (s *Server) routes() {
	s.mux.HandleFunc("GET /healthz", s.handleHealth)

	// 配对
	s.mux.HandleFunc("POST /pair/request", s.handlePairRequest)
	s.mux.HandleFunc("POST /pair/claim", s.handlePairClaim)
	s.mux.HandleFunc("POST /pair/approve", s.handlePairApprove)
	s.mux.HandleFunc("POST /pair/reject", s.handlePairReject)
	s.mux.HandleFunc("POST /pair/revoke", s.handlePairRevoke)
	s.mux.HandleFunc("GET /pair/current", s.handlePairCurrent)

	// 手机会话
	s.mux.HandleFunc("POST /api/session", s.handleSession)

	// 上行指令
	s.mux.HandleFunc("POST /api/task/start", s.handleTaskStart)
	s.mux.HandleFunc("POST /api/task/{taskId}/input", s.handleTaskInput)
	s.mux.HandleFunc("POST /api/task/{taskId}/cancel", s.handleTaskCancel)
	s.mux.HandleFunc("POST /api/task/focus", s.handleTaskFocus)
	s.mux.HandleFunc("GET /api/tasks", s.handleTaskList)
	s.mux.HandleFunc("GET /api/workspaces", s.handleWorkspaces)
	s.mux.HandleFunc("POST /api/history", s.handleHistory)
	s.mux.HandleFunc("POST /api/control", s.handleControl)
	s.mux.HandleFunc("POST /api/ui/respond", s.handleUIRespond)

	// 事件流 / 长连接
	s.mux.HandleFunc("GET /sse", s.handleSSE)
	s.mux.HandleFunc("GET /ws/bridge", s.handleBridgeWS)

	// blob：上传走 multipart，下载支持签名 URL（给 <img>）与凭据（给 bridge）
	s.mux.HandleFunc("POST /api/blob", s.handleBlobUpload)
	s.mux.HandleFunc("GET /api/blob/{id}/url", s.handleBlobURL)
	s.mux.HandleFunc("GET /blob/{id}", s.handleBlobGet)
}

// ── 中间件 ─────────────────────────────────────────────────────

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}

		// CORS：手机页面与云端同源部署时不需要，但本地联调必须
		if origin := r.Header.Get("Origin"); origin != "" && s.originAllowed(origin) {
			sw.Header().Set("Access-Control-Allow-Origin", origin)
			sw.Header().Set("Vary", "Origin")
			sw.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID")
			sw.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			sw.Header().Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			sw.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(sw, r)

		// /sse 是长连接，按「开始→结束」算耗时会很长，单独标记
		s.cfg.Log.Info("http",
			"method", r.Method,
			"path", r.URL.Path,
			"status", sw.status,
			"dur_ms", time.Since(start).Milliseconds(),
			"ip", clientIP(r),
		)
	})
}

func (s *Server) originAllowed(origin string) bool {
	if len(s.cfg.AllowedOrigins) == 0 {
		return true
	}
	for _, allowed := range s.cfg.AllowedOrigins {
		if strings.EqualFold(allowed, origin) {
			return true
		}
	}
	return false
}

type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (w *statusWriter) WriteHeader(code int) {
	if !w.wroteHeader {
		w.status = code
		w.wroteHeader = true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// ── 认证 ─────────────────────────────────────────────────────

type ctxKey string

const (
	ctxDevice ctxKey = "device"
	ctxUser   ctxKey = "user"
	ctxPair   ctxKey = "pair"
)

func deviceFrom(ctx context.Context) model.Device { return ctx.Value(ctxDevice).(model.Device) }
func userFrom(ctx context.Context) model.User     { return ctx.Value(ctxUser).(model.User) }
func pairFrom(ctx context.Context) model.Pair     { return ctx.Value(ctxPair).(model.Pair) }

// requireDevice 校验 `Authorization: Device <token>`。
//
// 注意方向：device 凭据是 PC 侧的，**只有它有权 approve**。
func (s *Server) requireDevice(r *http.Request) (model.Device, error) {
	plain, ok := auth.DeviceToken(r.Header.Get("Authorization"))
	if !ok {
		return model.Device{}, errUnauthorized
	}
	tok, err := s.cfg.Store.TokenByHash(r.Context(), auth.Hash(plain))
	if err != nil || tok.Kind != model.TokenDevice || tok.Revoked() || tok.Expired(s.cfg.Now()) {
		return model.Device{}, errUnauthorized
	}
	dev, err := s.cfg.Store.DeviceByID(r.Context(), tok.SubjectID)
	if err != nil {
		return model.Device{}, errUnauthorized
	}
	_ = s.cfg.Store.TouchToken(r.Context(), tok.ID, s.cfg.Now())
	_ = s.cfg.Store.TouchDevice(r.Context(), dev.ID, s.cfg.Now())
	return dev, nil
}

// requireUser 校验 Bearer（kind=user），用于 claim。
func (s *Server) requireUser(r *http.Request) (model.User, error) {
	plain, ok := auth.BearerToken(r.Header.Get("Authorization"))
	if !ok {
		return model.User{}, errUnauthorized
	}
	tok, err := s.cfg.Store.TokenByHash(r.Context(), auth.Hash(plain))
	if err != nil || tok.Kind != model.TokenUser || tok.Revoked() || tok.Expired(s.cfg.Now()) {
		return model.User{}, errUnauthorized
	}
	user, err := s.cfg.Store.UserByID(r.Context(), tok.SubjectID)
	if err != nil {
		return model.User{}, errUnauthorized
	}
	return user, nil
}

// requirePairToken 校验 Bearer（kind=pair），返回对应 pair。
func (s *Server) requirePairToken(r *http.Request, pairRef string) (model.Pair, error) {
	plain, ok := auth.BearerToken(r.Header.Get("Authorization"))
	if !ok {
		return model.Pair{}, errUnauthorized
	}
	tok, err := s.cfg.Store.TokenByHash(r.Context(), auth.Hash(plain))
	if err != nil || tok.Kind != model.TokenPair || tok.Revoked() || tok.Expired(s.cfg.Now()) {
		return model.Pair{}, errUnauthorized
	}
	pair, err := s.cfg.Store.PairByID(r.Context(), tok.SubjectID)
	if err != nil {
		return model.Pair{}, errUnauthorized
	}
	if pair.Status != model.PairActive && pair.Status != model.PairSuspended {
		return model.Pair{}, errPairNotActive
	}
	if pairRef != "" {
		id, err := protocol.ParseRef(pairRef, "p")
		if err != nil || id != pair.ID {
			return model.Pair{}, errUnauthorized
		}
	}
	_ = s.cfg.Store.TouchToken(r.Context(), tok.ID, s.cfg.Now())
	return pair, nil
}

// ── 响应助手 ─────────────────────────────────────────────────

var (
	errUnauthorized  = errors.New("unauthorized")
	errBadRequest    = errors.New("bad_request")
	errPairNotActive = errors.New("pair_not_active")
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]string{"error": code, "message": msg})
}

// fail 把领域错误统一翻译成 HTTP 状态码，避免每个 handler 各写一套。
func (s *Server) fail(w http.ResponseWriter, err error) {
	now := s.cfg.Now()
	_ = now
	switch {
	case errors.Is(err, errUnauthorized), errors.Is(err, pairing.ErrUnauthorized):
		writeErr(w, http.StatusUnauthorized, "unauthorized", "凭据无效或已过期")
	case errors.Is(err, pairing.ErrCodeNotFound):
		writeErr(w, http.StatusNotFound, "code_not_found", "配对码不存在或已过期")
	case errors.Is(err, pairing.ErrAlreadyClaimed):
		writeErr(w, http.StatusConflict, "already_claimed", "该配对码已被其他设备认领")
	case errors.Is(err, pairing.ErrDeviceBusy), errors.Is(err, store.ErrConflict):
		writeErr(w, http.StatusConflict, "device_busy", "该设备已有生效中的配对")
	case errors.Is(err, pairing.ErrTakeoverNeeded):
		writeErr(w, http.StatusConflict, "takeover_required", "该设备已有生效中的配对，批准将断开它（需 takeover=true）")
	case errors.Is(err, pairing.ErrPairNotActive):
		writeErr(w, http.StatusForbidden, "pair_not_active", "配对未生效或已断开")
	case errors.Is(err, hub.ErrBridgeOffline):
		writeErr(w, http.StatusServiceUnavailable, "bridge_offline", "目标设备当前不在线")
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not_found", "记录不存在")
	default:
		s.cfg.Log.Error("request failed", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal", "服务内部错误")
	}
}

func decode(r *http.Request, v any) error {
	defer func() { _ = r.Body.Close() }()
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return errBadRequest
	}
	return nil
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if idx := strings.IndexByte(xff, ','); idx > 0 {
			return strings.TrimSpace(xff[:idx])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ── 限速 ─────────────────────────────────────────────────────

type rateLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	hits   map[string][]int64
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	return &rateLimiter{limit: limit, window: window, hits: map[string][]int64{}}
}

// allow 报告 key 在窗口内是否仍可用；顺便清理过期记录。
func (l *rateLimiter) allow(key string, now int64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := now - l.window.Milliseconds()
	list := l.hits[key]
	kept := list[:0]
	for _, ts := range list {
		if ts > cutoff {
			kept = append(kept, ts)
		}
	}
	if len(kept) >= l.limit {
		l.hits[key] = kept
		return false
	}
	l.hits[key] = append(kept, now)
	return true
}
