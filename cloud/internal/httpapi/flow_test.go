package httpapi_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/leon82/pcp/cloud/internal/auth"
	"github.com/leon82/pcp/cloud/internal/httpapi"
	"github.com/leon82/pcp/cloud/internal/hub"
	"github.com/leon82/pcp/cloud/internal/model"
	"github.com/leon82/pcp/cloud/internal/pairing"
	"github.com/leon82/pcp/cloud/internal/protocol"
	"github.com/leon82/pcp/cloud/internal/store"
	"github.com/leon82/pcp/cloud/internal/store/memory"
)

type env struct {
	t        *testing.T
	srv      *httptest.Server
	store    store.Store
	hub      *hub.Hub
	userTok  string
	devTok   string
	deviceID model.ID
	userID   model.ID
}

func newEnv(t *testing.T) *env {
	t.Helper()
	st := memory.New()
	h := hub.New()
	svc := httpapi.New(httpapi.Config{Store: st, Pairing: pairing.New(st, pairing.DefaultConfig()), Hub: h})
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)

	now := time.Now().UnixMilli()
	user, err := st.UpsertUser(context.Background(), "tester", "tester", now)
	if err != nil {
		t.Fatal(err)
	}
	dev := model.Device{ID: model.NewID(), Name: "dev-1", Fingerprint: "fp-1", CreatedAt: now}
	if err := st.CreateDevice(context.Background(), dev); err != nil {
		t.Fatal(err)
	}

	mintToken := func(subject model.ID, kind model.TokenKind) string {
		plain, hash := auth.NewToken()
		if err := st.CreateToken(context.Background(), model.Token{
			ID: model.NewID(), Kind: kind, SubjectID: subject, Hash: hash, CreatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
		return plain
	}

	return &env{
		t: t, srv: srv, store: st, hub: h,
		userTok:  mintToken(user.ID, model.TokenUser),
		devTok:   mintToken(dev.ID, model.TokenDevice),
		deviceID: dev.ID,
		userID:   user.ID,
	}
}

func (e *env) do(method, path, authz string, body any, out any) *http.Response {
	e.t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			e.t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, e.srv.URL+path, reader)
	if err != nil {
		e.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if authz != "" {
		req.Header.Set("Authorization", authz)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	if out != nil {
		defer resp.Body.Close()
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			e.t.Fatalf("解析响应失败: %v", err)
		}
	}
	return resp
}

type pairRequestResp struct {
	Code      string `json:"code"`
	ExpiresAt int64  `json:"expiresAt"`
}

type claimResp struct {
	PairID       string `json:"pairId"`
	Status       string `json:"status"`
	RefreshToken string `json:"refreshToken"`
}

// 完整主链路：request → claim → approve → session → 任务上行 → 撤销
func TestPairingHappyPath(t *testing.T) {
	e := newEnv(t)

	var pr pairRequestResp
	resp := e.do("POST", "/pair/request", "Device "+e.devTok, map[string]any{}, &pr)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("request 状态码 %d", resp.StatusCode)
	}
	if len(pr.Code) != 6 {
		t.Fatalf("配对码应为 6 位，实际 %q", pr.Code)
	}

	var claim claimResp
	resp = e.do("POST", "/pair/claim", "Bearer "+e.userTok,
		map[string]any{"code": pr.Code, "deviceName": "iPhone 15", "platform": "web"}, &claim)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("claim 状态码 %d", resp.StatusCode)
	}
	if claim.Status != string(model.PairPendingApproval) {
		t.Fatalf("claim 后状态应为 pending_approval，实际 %s", claim.Status)
	}
	if claim.RefreshToken == "" {
		t.Fatal("claim 应返回 refreshToken")
	}

	// 未批准前不能换 pairToken
	var sess map[string]any
	resp = e.do("POST", "/api/session", "Bearer "+claim.RefreshToken,
		map[string]any{"pairId": claim.PairID}, &sess)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("未批准时应 403，实际 %d", resp.StatusCode)
	}

	var approve map[string]any
	resp = e.do("POST", "/pair/approve", "Device "+e.devTok,
		map[string]any{"pairId": claim.PairID, "decision": "approve"}, &approve)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("approve 状态码 %d", resp.StatusCode)
	}

	var session struct {
		PairToken string `json:"pairToken"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	resp = e.do("POST", "/api/session", "Bearer "+claim.RefreshToken,
		map[string]any{"pairId": claim.PairID}, &session)
	if resp.StatusCode != http.StatusOK || session.PairToken == "" {
		t.Fatalf("批准后应能换到 pairToken，状态码 %d", resp.StatusCode)
	}

	// bridge 离线时 task.start 应 503 而不是假装成功
	resp = e.do("POST", "/api/task/start?pairId="+claim.PairID, "Bearer "+session.PairToken,
		map[string]any{"prompt": "hi", "workspace": "/work/a"}, nil)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("bridge 离线应 503，实际 %d", resp.StatusCode)
	}

	// 撤销后 pairToken 立即失效
	resp = e.do("POST", "/pair/revoke", "Device "+e.devTok,
		map[string]any{"pairId": claim.PairID, "reason": "test"}, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("revoke 状态码 %d", resp.StatusCode)
	}
	resp = e.do("POST", "/api/session", "Bearer "+claim.RefreshToken,
		map[string]any{"pairId": claim.PairID}, nil)
	if resp.StatusCode == http.StatusOK {
		t.Fatal("撤销后 refreshToken 不应还能换 token")
	}
}

// 抢码必须硬拒绝，且不提供覆盖路径。
func TestSecondClaimRejected(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()

	var pr pairRequestResp
	e.do("POST", "/pair/request", "Device "+e.devTok, map[string]any{}, &pr)

	// 第一台手机
	var first claimResp
	if resp := e.do("POST", "/pair/claim", "Bearer "+e.userTok,
		map[string]any{"code": pr.Code, "deviceName": "phone-A"}, &first); resp.StatusCode != http.StatusOK {
		t.Fatalf("首个 claim 应成功，实际 %d", resp.StatusCode)
	}

	// 第二台手机（另一个用户）
	other, err := e.store.UpsertUser(ctx, "intruder", "intruder", time.Now().UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	plain, hash := auth.NewToken()
	if err := e.store.CreateToken(ctx, model.Token{
		ID: model.NewID(), Kind: model.TokenUser, SubjectID: other.ID,
		Hash: hash, CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}

	resp := e.do("POST", "/pair/claim", "Bearer "+plain,
		map[string]any{"code": pr.Code, "deviceName": "phone-B"}, nil)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("抢码应 409，实际 %d", resp.StatusCode)
	}

	// 同一用户重复 claim 是幂等的（弱网重试）
	var again claimResp
	resp = e.do("POST", "/pair/claim", "Bearer "+e.userTok,
		map[string]any{"code": pr.Code, "deviceName": "phone-A"}, &again)
	if resp.StatusCode != http.StatusOK || again.PairID != first.PairID {
		t.Fatalf("同一用户重复 claim 应幂等，状态码 %d pairId %s vs %s", resp.StatusCode, again.PairID, first.PairID)
	}
}

// 过期的码不可用；乱码不可用。
func TestClaimRejectsBadCode(t *testing.T) {
	e := newEnv(t)
	resp := e.do("POST", "/pair/claim", "Bearer "+e.userTok,
		map[string]any{"code": "ZZZZZZ", "deviceName": "x"}, nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("不存在的码应 404，实际 %d", resp.StatusCode)
	}
}

// 云端不能批准 —— 没有 device 凭据就不能 approve。
func TestApproveRequiresDeviceToken(t *testing.T) {
	e := newEnv(t)
	var pr pairRequestResp
	e.do("POST", "/pair/request", "Device "+e.devTok, map[string]any{}, &pr)
	var claim claimResp
	e.do("POST", "/pair/claim", "Bearer "+e.userTok, map[string]any{"code": pr.Code, "deviceName": "x"}, &claim)

	// 手机（user 凭据）试图自我批准：必须被拒
	resp := e.do("POST", "/pair/approve", "Bearer "+e.userTok,
		map[string]any{"pairId": claim.PairID, "decision": "approve"}, nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("非 device 凭据 approve 应 401，实际 %d", resp.StatusCode)
	}
}

// bridge 长连 + 下行路由 + 上行事件转发到 SSE
func TestBridgeRelayAndSSE(t *testing.T) {
	e := newEnv(t)

	// 先建立配对
	var pr pairRequestResp
	e.do("POST", "/pair/request", "Device "+e.devTok, map[string]any{}, &pr)
	var claim claimResp
	e.do("POST", "/pair/claim", "Bearer "+e.userTok, map[string]any{"code": pr.Code, "deviceName": "x"}, &claim)
	e.do("POST", "/pair/approve", "Device "+e.devTok, map[string]any{"pairId": claim.PairID, "decision": "approve"}, nil)

	// bridge 连上来
	wsURL := strings.Replace(e.srv.URL, "http://", "ws://", 1) + "/ws/bridge"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Device " + e.devTok}},
	})
	if err != nil {
		t.Fatalf("bridge 连接失败: %v", err)
	}
	defer conn.CloseNow()

	hello, _ := protocol.New(protocol.TypeBridgeHello, time.Now().UnixMilli()).
		WithPayload(protocol.BridgeHello{DeviceID: e.deviceID.String(), Version: protocol.Version,
			Name: "dev-1", Workspaces: []string{"/work/a"}})
	raw, _ := protocol.Marshal(hello)
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("发送 hello 失败: %v", err)
	}

	// 应收到 welcome
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("读取 welcome 失败: %v", err)
	}
	var welcome protocol.Envelope
	if err := json.Unmarshal(data, &welcome); err != nil {
		t.Fatal(err)
	}
	if welcome.Type != protocol.TypeBridgeWelcome {
		t.Fatalf("首帧应为 bridge.welcome，实际 %s", welcome.Type)
	}

	// 等 bridge 注册生效
	deadline := time.Now().Add(2 * time.Second)
	for !e.hub.Online(e.deviceID) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !e.hub.Online(e.deviceID) {
		t.Fatal("bridge 未注册到 hub")
	}

	// 换 pairToken 并订阅 SSE
	var session struct {
		PairToken string `json:"pairToken"`
	}
	e.do("POST", "/api/session", "Bearer "+claim.RefreshToken, map[string]any{"pairId": claim.PairID}, &session)

	sseReq, _ := http.NewRequest("GET", e.srv.URL+"/sse?pairId="+claim.PairID, nil)
	sseReq.Header.Set("Authorization", "Bearer "+session.PairToken)
	sseResp, err := http.DefaultClient.Do(sseReq)
	if err != nil {
		t.Fatalf("SSE 连接失败: %v", err)
	}
	defer sseResp.Body.Close()
	if ct := sseResp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("SSE Content-Type 错误: %s", ct)
	}
	if sseResp.Header.Get("X-Accel-Buffering") != "no" {
		t.Fatal("SSE 必须带 X-Accel-Buffering: no，否则 nginx 会攒事件")
	}

	// 手机发任务 → bridge 收到 task.start
	var startResp struct {
		TaskID string `json:"taskId"`
	}
	e.do("POST", "/api/task/start?pairId="+claim.PairID, "Bearer "+session.PairToken,
		map[string]any{"prompt": "hello", "workspace": "/work/a"}, &startResp)
	if startResp.TaskID == "" {
		t.Fatal("task.start 应返回 taskId")
	}

	_, downData, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("bridge 未收到 task.start: %v", err)
	}
	var down protocol.Envelope
	_ = json.Unmarshal(downData, &down)
	if down.Type != protocol.TypeTaskStart || down.TaskID != startResp.TaskID {
		t.Fatalf("下行帧错误: type=%s taskId=%s", down.Type, down.TaskID)
	}

	// bridge 回一个 pi.event → 手机 SSE 应收到
	event, _ := protocol.New(protocol.TypePiEvent, time.Now().UnixMilli()).
		WithPayload(map[string]string{"type": "message_update"})
	event.PairID = claim.PairID
	event.TaskID = startResp.TaskID
	rawEvent, _ := protocol.Marshal(event)
	if err := conn.Write(ctx, websocket.MessageText, rawEvent); err != nil {
		t.Fatalf("bridge 发送事件失败: %v", err)
	}

	reader := newSSEReader(sseResp.Body)
	seen := false
	for i := 0; i < 6; i++ {
		ev, ok := reader.next()
		if !ok {
			break
		}
		if ev.event == protocol.TypePiEvent {
			seen = true
			var env protocol.Envelope
			if err := json.Unmarshal([]byte(ev.data), &env); err != nil {
				t.Fatalf("SSE data 不是合法信封: %v", err)
			}
			if env.Seq == 0 {
				t.Fatal("SSE 帧必须带 seq")
			}
			break
		}
	}
	if !seen {
		t.Fatal("手机 SSE 未收到 pi.event")
	}
}

// workspace 白名单：不在名单内的目录必须拒绝，不能放任远程 cd。
func TestWorkspaceAllowlist(t *testing.T) {
	e := newEnv(t)
	var pr pairRequestResp
	e.do("POST", "/pair/request", "Device "+e.devTok, map[string]any{}, &pr)
	var claim claimResp
	e.do("POST", "/pair/claim", "Bearer "+e.userTok, map[string]any{"code": pr.Code, "deviceName": "x"}, &claim)
	e.do("POST", "/pair/approve", "Device "+e.devTok, map[string]any{"pairId": claim.PairID, "decision": "approve"}, nil)

	var session struct {
		PairToken string `json:"pairToken"`
	}
	e.do("POST", "/api/session", "Bearer "+claim.RefreshToken, map[string]any{"pairId": claim.PairID}, &session)

	// 手工注册一个只允许 /work/a 的 bridge
	e.hub.RegisterBridge(e.deviceID, "dev-1", []string{"/work/a"})

	resp := e.do("POST", "/api/task/start?pairId="+claim.PairID, "Bearer "+session.PairToken,
		map[string]any{"prompt": "hi", "workspace": "/etc"}, nil)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("白名单外目录应 400，实际 %d", resp.StatusCode)
	}
	resp = e.do("POST", "/api/task/start?pairId="+claim.PairID, "Bearer "+session.PairToken,
		map[string]any{"prompt": "hi", "workspace": "/work/a"}, nil)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("白名单内目录应 202，实际 %d", resp.StatusCode)
	}
}

// ── SSE 解析 ──────────────────────────────────────────────────

type sseEvent struct{ id, event, data string }

type sseReader struct {
	r *bufio.Reader
}

func newSSEReader(r io.Reader) *sseReader { return &sseReader{r: bufio.NewReader(r)} }

// next 读取一个 SSE 事件块：累积到空行为止（跳过心跳注释行）。
func (s *sseReader) next() (sseEvent, bool) {
	var ev sseEvent
	for {
		line, err := s.r.ReadString('\n')
		line = strings.TrimRight(line, "\r\n")
		switch {
		case strings.HasPrefix(line, "id: "):
			ev.id = strings.TrimPrefix(line, "id: ")
		case strings.HasPrefix(line, "event: "):
			ev.event = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			ev.data = strings.TrimPrefix(line, "data: ")
		}
		if line == "" && ev.data != "" {
			return ev, true
		}
		if err != nil {
			return ev, ev.data != ""
		}
	}
}
