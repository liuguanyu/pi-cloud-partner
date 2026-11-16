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

// setupPairedBridge 建立「已配对 + bridge 在线」的最小场景，返回 taskId 之外的所有句柄。
func setupPairedBridge(t *testing.T, e *env) (pairIDRef string, pairToken string, conn *websocket.Conn, ctx context.Context) {
	t.Helper()

	var pr pairRequestResp
	e.do("POST", "/pair/request", "Device "+e.devTok, map[string]any{}, &pr)
	var claim claimResp
	e.do("POST", "/pair/claim", "",
		map[string]any{"code": pr.Code, "deviceName": "x", "claimantId": "claim-a"}, &claim)
	e.do("POST", "/pair/approve", "Device "+e.devTok,
		map[string]any{"pairId": claim.PairID, "decision": "approve"}, nil)

	var session struct {
		PairToken string `json:"pairToken"`
	}
	e.do("POST", "/api/session", "Bearer "+claim.RefreshToken,
		map[string]any{"pairId": claim.PairID}, &session)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)

	wsURL := strings.Replace(e.srv.URL, "http://", "ws://", 1) + "/ws/bridge"
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Device " + e.devTok}},
	})
	if err != nil {
		t.Fatalf("bridge 连接失败: %v", err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })

	hello, _ := protocol.New(protocol.TypeBridgeHello, time.Now().UnixMilli()).
		WithPayload(protocol.BridgeHello{DeviceID: e.deviceID.String(), Version: protocol.Version, Name: "dev"})
	raw, _ := protocol.Marshal(hello)
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("hello 发送失败: %v", err)
	}
	if _, _, err := conn.Read(ctx); err != nil {
		t.Fatalf("未收到 welcome: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for !e.hub.Online(e.deviceID) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	return claim.PairID, session.PairToken, conn, ctx
}

func sendSnapshot(t *testing.T, conn *websocket.Conn, ctx context.Context, tasks []protocol.SnapshotTask) {
	t.Helper()
	env, _ := protocol.New(protocol.TypeStateSnapshot, time.Now().UnixMilli()).
		WithPayload(protocol.StateSnapshot{Tasks: tasks})
	raw, _ := protocol.Marshal(env)
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("快照发送失败: %v", err)
	}
	// 等云端处理完（处理是异步的）
	time.Sleep(150 * time.Millisecond)
}

func taskStatus(t *testing.T, e *env, pairIDRef, pairToken, taskRef string) string {
	t.Helper()
	var list struct {
		Tasks []struct {
			TaskID string `json:"taskId"`
			Status string `json:"status"`
		} `json:"tasks"`
	}
	e.do("GET", "/api/tasks?pairId="+pairIDRef, "Bearer "+pairToken, nil, &list)
	for _, task := range list.Tasks {
		if task.TaskID == taskRef {
			return task.Status
		}
	}
	return ""
}

// 核心契约：库里非终态、但快照里没有 → 说明断连期间结束了，必须标 interrupted。
func TestReconcileMarksInterrupted(t *testing.T) {
	e := newEnv(t)
	pairRef, pairToken, conn, ctx := setupPairedBridge(t, e)

	pairID, err := protocol.ParseRef(pairRef, "p")
	if err != nil {
		t.Fatal(err)
	}
	taskID := model.NewID()
	started := time.Now().UnixMilli()
	if err := e.store.UpsertTask(ctx, model.Task{
		ID: taskID, PairID: pairID, Workspace: "/work/a", Status: "running", Title: "t", StartedAt: &started,
	}); err != nil {
		t.Fatal(err)
	}
	taskRef := protocol.RefTask(taskID)

	// bridge 上报「我一个任务都没在跑」→ 那个 running 是陈旧缓存
	sendSnapshot(t, conn, ctx, nil)

	if got := taskStatus(t, e, pairRef, pairToken, taskRef); got != "interrupted" {
		t.Fatalf("期望 interrupted，实际 %q", got)
	}
}

// 快照以 bridge 为准：它说还在跑，云端就改回 running。
func TestReconcileTrustsBridge(t *testing.T) {
	e := newEnv(t)
	pairRef, pairToken, conn, ctx := setupPairedBridge(t, e)

	pairID, _ := protocol.ParseRef(pairRef, "p")
	taskID := model.NewID()
	started := time.Now().UnixMilli()
	if err := e.store.UpsertTask(ctx, model.Task{
		ID: taskID, PairID: pairID, Workspace: "/work/a", Status: "queued", Title: "t", StartedAt: &started,
	}); err != nil {
		t.Fatal(err)
	}
	taskRef := protocol.RefTask(taskID)

	sendSnapshot(t, conn, ctx, []protocol.SnapshotTask{{TaskID: taskRef, Status: "running"}})

	if got := taskStatus(t, e, pairRef, pairToken, taskRef); got != "running" {
		t.Fatalf("期望 running，实际 %q", got)
	}
}

// 待审批的任务：对账必须把审批弹层重新推给手机，否则重启后永远点不了。
func TestReconcileRepublishesApproval(t *testing.T) {
	e := newEnv(t)
	pairRef, pairToken, conn, ctx := setupPairedBridge(t, e)

	pairID, _ := protocol.ParseRef(pairRef, "p")
	taskID := model.NewID()
	started := time.Now().UnixMilli()
	if err := e.store.UpsertTask(ctx, model.Task{
		ID: taskID, PairID: pairID, Workspace: "/work/a", Status: "awaiting_approval", Title: "t", StartedAt: &started,
	}); err != nil {
		t.Fatal(err)
	}
	taskRef := protocol.RefTask(taskID)

	// 手机先订阅
	sseReq, _ := http.NewRequest("GET", e.srv.URL+"/sse?pairId="+pairRef, nil)
	sseReq.Header.Set("Authorization", "Bearer "+pairToken)
	sseResp, err := http.DefaultClient.Do(sseReq)
	if err != nil {
		t.Fatal(err)
	}
	defer sseResp.Body.Close()
	reader := newSSEReader(sseResp.Body)
	// 先消费掉 stream.hello
	reader.next()

	sendSnapshot(t, conn, ctx, []protocol.SnapshotTask{{
		TaskID: taskRef,
		Status: "awaiting_approval",
		Approval: &protocol.SnapshotApproval{
			RequestID: "req-42",
			Method:    "confirm",
			Title:     "远程审批：write",
			Message:   `{"path":"/tmp/x"}`,
			TaskID:    taskRef,
		},
	}})

	found := false
	for i := 0; i < 8; i++ {
		ev, ok := reader.next()
		if !ok {
			break
		}
		if ev.event != protocol.TypeUIRequest {
			continue
		}
		var env protocol.Envelope
		if err := json.Unmarshal([]byte(ev.data), &env); err != nil {
			t.Fatalf("非法信封: %v", err)
		}
		var payload struct {
			RequestID string `json:"requestId"`
			Title     string `json:"title"`
		}
		_ = env.Decode(&payload)
		if payload.RequestID == "req-42" && payload.Title == "远程审批：write" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("对账应把 ui.request 重新推给手机")
	}
}

// bridge 离线时，库里的非终态状态不可信 → 视图层返回 stale，但不改库。
func TestOfflineBridgeShowsStale(t *testing.T) {
	e := newEnv(t)
	pairRef, pairToken, conn, ctx := setupPairedBridge(t, e)

	pairID, _ := protocol.ParseRef(pairRef, "p")
	taskID := model.NewID()
	started := time.Now().UnixMilli()
	if err := e.store.UpsertTask(ctx, model.Task{
		ID: taskID, PairID: pairID, Workspace: "/work/a", Status: "running", Title: "t", StartedAt: &started,
	}); err != nil {
		t.Fatal(err)
	}
	taskRef := protocol.RefTask(taskID)

	_ = conn.CloseNow()
	deadline := time.Now().Add(3 * time.Second)
	for e.hub.Online(e.deviceID) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if e.hub.Online(e.deviceID) {
		t.Fatal("bridge 应已离线")
	}

	if got := taskStatus(t, e, pairRef, pairToken, taskRef); got != "stale" {
		t.Fatalf("期望 stale，实际 %q", got)
	}

	// 库里仍是 running：视图层降级不应污染权威数据
	stored, err := e.store.TaskByID(ctx, taskID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != "running" {
		t.Fatalf("库里状态不该被视图层改写，实际 %q", stored.Status)
	}
}
