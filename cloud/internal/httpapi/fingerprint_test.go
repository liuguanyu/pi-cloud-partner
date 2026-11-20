package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/leon82/pcp/cloud/internal/model"
	"github.com/leon82/pcp/cloud/internal/protocol"
)

// 同一台手机（浏览器环境指纹一致）重新配对时免人工批准。
// 覆盖三个分支：同指纹→自动 active；异指纹→保持 pending；无历史→保持 pending。
// storeAudit 读取某 pair 指定 action 的审计条数。
func storeAudit(t *testing.T, e *env, pairRef, action string) []string {
	t.Helper()
	id, err := protocol.ParseRef(pairRef, "p")
	if err != nil {
		t.Fatal(err)
	}
	events, err := e.store.ListAudit(context.Background(), id, 100)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, ev := range events {
		if ev.Action == action {
			out = append(out, ev.Actor+":"+ev.Meta)
		}
	}
	return out
}

func TestRepeatClientAutoApproveByFingerprint(t *testing.T) {
	e := newEnv(t)
	fp := "fp-iphone-15-same-env"

	// ── 第一次配对（正常人工批准）──
	var pr pairRequestResp
	e.do("POST", "/pair/request", "Device "+e.devTok, map[string]any{}, &pr)
	var claim1 claimResp
	resp := e.do("POST", "/pair/claim", "", map[string]any{
		"code": pr.Code, "deviceName": "iPhone", "claimantId": "c1", "fingerprint": fp,
	}, &claim1)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("首次 claim 应成功，实际 %d", resp.StatusCode)
	}
	if claim1.Status != "pending_approval" {
		t.Fatalf("首次配对（无历史）必须保持 pending，实际 %s", claim1.Status)
	}
	e.do("POST", "/pair/approve", "Device "+e.devTok, map[string]any{"pairId": claim1.PairID, "decision": "approve"}, nil)

	// ── 第一次配对失效（模拟凭据被 iOS 清掉后重连）──
	e.do("POST", "/pair/revoke", "Device "+e.devTok, map[string]any{"pairId": claim1.PairID, "reason": "test"}, nil)

	// ── 第二次配对：同指纹 → 自动批准，无需 PC ──
	var pr2 pairRequestResp
	e.do("POST", "/pair/request", "Device "+e.devTok, map[string]any{}, &pr2)
	var claim2 claimResp
	resp = e.do("POST", "/pair/claim", "", map[string]any{
		"code": pr2.Code, "deviceName": "iPhone", "claimantId": "c2", "fingerprint": fp,
	}, &claim2)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("重配对 claim 应成功，实际 %d", resp.StatusCode)
	}
	if claim2.Status != "active" {
		t.Fatalf("同指纹重配对应自动批准为 active，实际 %s", claim2.Status)
	}

	// 自动批准必须留审计（meta 是 JSON 列，写坏会静默丢失）
	approvals := storeAudit(t, e, claim2.PairID, "pair.approved")
	if len(approvals) != 1 {
		t.Fatalf("自动批准应恰好一条 pair.approved 审计，实际 %d", len(approvals))
	}

	// ── 第三次配对：不同指纹 → 保持 pending（必须人工批准）──
	e.do("POST", "/pair/revoke", "Device "+e.devTok, map[string]any{"pairId": claim2.PairID, "reason": "test"}, nil)
	var pr3 pairRequestResp
	e.do("POST", "/pair/request", "Device "+e.devTok, map[string]any{}, &pr3)
	var claim3 claimResp
	resp = e.do("POST", "/pair/claim", "", map[string]any{
		"code": pr3.Code, "deviceName": "另一台手机", "claimantId": "c3", "fingerprint": "fp-other-device",
	}, &claim3)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("异指纹 claim 应成功，实际 %d", resp.StatusCode)
	}
	if claim3.Status != "pending_approval" {
		t.Fatalf("异指纹必须保持 pending（人工批准），实际 %s", claim3.Status)
	}

	// 未批准时不能换 token
	var sess map[string]any
	resp = e.do("POST", "/api/session", "Bearer "+claim3.RefreshToken, map[string]any{"pairId": claim3.PairID}, &sess)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("未批准 pair 换 token 应 403，实际 %d", resp.StatusCode)
	}

	// ── 第四次：不带指纹 → 保持 pending ──
	e.do("POST", "/pair/revoke", "Device "+e.devTok, map[string]any{"pairId": claim3.PairID, "reason": "test"}, nil)
	var pr4 pairRequestResp
	e.do("POST", "/pair/request", "Device "+e.devTok, map[string]any{}, &pr4)
	var claim4 claimResp
	e.do("POST", "/pair/claim", "", map[string]any{
		"code": pr4.Code, "deviceName": "老版客户端", "claimantId": "c4",
	}, &claim4)
	if claim4.Status != "pending_approval" {
		t.Fatalf("不带指纹必须保持 pending，实际 %s", claim4.Status)
	}
}

// 回归：follow_up 必须带 workspace/sessionId —— bridge 重启后内存表为空，
// 云端不下发这两项，bridge 只能回 unknown_task（表现为"点继续没反应"）。
func TestFollowUpCarriesSessionContext(t *testing.T) {
	e := newEnv(t)

	var pr pairRequestResp
	e.do("POST", "/pair/request", "Device "+e.devTok, map[string]any{}, &pr)
	var claim claimResp
	e.do("POST", "/pair/claim", "", map[string]any{"code": pr.Code, "deviceName": "p", "claimantId": "c1"}, &claim)
	e.do("POST", "/pair/approve", "Device "+e.devTok, map[string]any{"pairId": claim.PairID, "decision": "approve"}, nil)
	var sess struct {
		PairToken string `json:"pairToken"`
	}
	e.do("POST", "/api/session", "Bearer "+claim.RefreshToken, map[string]any{"pairId": claim.PairID}, &sess)

	// bridge 上线
	wsURL := strings.Replace(e.srv.URL, "http://", "ws://", 1) + "/ws/bridge"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Device " + e.devTok}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	hello, _ := protocol.New(protocol.TypeBridgeHello, time.Now().UnixMilli()).
		WithPayload(protocol.BridgeHello{DeviceID: e.deviceID.String(), Version: protocol.Version,
			Name: "d", Workspaces: []string{"/work/a"}})
	raw, _ := protocol.Marshal(hello)
	_ = conn.Write(ctx, websocket.MessageText, raw)
	if _, _, err := conn.Read(ctx); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for !e.hub.Online(e.deviceID) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}

	// 造一个"已结束但有 sessionId"的老任务
	pairID, err := protocol.ParseRef(claim.PairID, "p")
	if err != nil {
		t.Fatal(err)
	}
	taskID := model.NewID()
	if err := e.store.UpsertTask(context.Background(), model.Task{
		ID: taskID, PairID: pairID, Workspace: "/work/a", Status: "settled",
		Title: "老任务", SessionID: "11111111-2222-3333-4444-555555555555",
	}); err != nil {
		t.Fatal(err)
	}

	// 手机续聊
	resp := e.do("POST", "/api/task/t_"+taskID.String()+"/input?pairId="+claim.PairID,
		"Bearer "+sess.PairToken,
		map[string]any{"text": "再发一次", "mode": "follow_up"}, nil)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("follow_up 应 202，实际 %d", resp.StatusCode)
	}
	resp.Body.Close()

	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var down protocol.Envelope
	if err := json.Unmarshal(data, &down); err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(down.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["workspace"] != "/work/a" {
		t.Fatalf("follow_up 必须带 workspace，实际 %v", payload["workspace"])
	}
	if payload["sessionId"] != "11111111-2222-3333-4444-555555555555" {
		t.Fatalf("follow_up 必须带 sessionId，实际 %v", payload["sessionId"])
	}
}
