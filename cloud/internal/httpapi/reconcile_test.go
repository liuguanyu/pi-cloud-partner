package httpapi_test

import (
	"context"
	"encoding/json"
	"io"
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

// 「从未开始」与「中途失联」必须区分：前者是下发时链路就断了（任务没跑），
// 后者是跑过但结束事件丢了。文案完全不同，混在一起会误导用户。
func TestReconcileDistinguishesNeverStarted(t *testing.T) {
	e := newEnv(t)
	pairRef, _, conn, ctx := setupPairedBridge(t, e)

	pairID, _ := protocol.ParseRef(pairRef, "p")
	taskID := model.NewID()
	// 注意：StartedAt 为 nil —— 桥接侧从未开始执行
	if err := e.store.UpsertTask(ctx, model.Task{
		ID: taskID, PairID: pairID, Workspace: "/work/a", Status: "queued", Title: "t",
	}); err != nil {
		t.Fatal(err)
	}
	sendSnapshot(t, conn, ctx, nil)

	task, err := e.store.TaskByID(ctx, taskID)
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != "failed" || task.ExitReason != "not_started" {
		t.Fatalf("期望 failed/not_started，实际 %s/%s", task.Status, task.ExitReason)
	}
}

// 回归：pair 换代后（手机重扫码），旧代 pair 名下的任务必须仍可见，
// 且 bridge 带旧 pairId 上报的实时事件必须被重路由到 active pair 的 ring。
func TestCrossGenerationTasksVisibleAndRerouted(t *testing.T) {
	e := newEnv(t)

	// ── 第一代 pair（将被 revoke）──
	var pr1 pairRequestResp
	e.do("POST", "/pair/request", "Device "+e.devTok, map[string]any{}, &pr1)
	var claim1 claimResp
	e.do("POST", "/pair/claim", "", map[string]any{"code": pr1.Code, "deviceName": "phone", "claimantId": "gen-1"}, &claim1)
	e.do("POST", "/pair/approve", "Device "+e.devTok, map[string]any{"pairId": claim1.PairID, "decision": "approve"}, nil)
	var sess1 struct {
		PairToken string `json:"pairToken"`
	}
	e.do("POST", "/api/session", "Bearer "+claim1.RefreshToken, map[string]any{"pairId": claim1.PairID}, &sess1)

	// 第一代 pair 名下建一个任务（直接写库，绕过 bridge 在线要求）
	gen1PairID, err := model.ParseID(strings.TrimPrefix(claim1.PairID, "p_"))
	if err != nil {
		t.Fatal(err)
	}
	taskID := model.NewID()
	if err := e.store.UpsertTask(context.Background(), model.Task{
		ID: taskID, PairID: gen1PairID, Workspace: "/work/a", Status: "settled",
		Title: "第一代任务", SessionID: "00000000-0000-0000-0000-000000000000",
	}); err != nil {
		t.Fatal(err)
	}

	// ── 第一代 pair 被顶替（模拟"手机重新扫码"）──
	var pr2 pairRequestResp
	e.do("POST", "/pair/request", "Device "+e.devTok, map[string]any{}, &pr2)
	var claim2 claimResp
	e.do("POST", "/pair/claim", "", map[string]any{"code": pr2.Code, "deviceName": "phone", "claimantId": "gen-2"}, &claim2)
	e.do("POST", "/pair/approve", "Device "+e.devTok, map[string]any{"pairId": claim2.PairID, "decision": "approve", "takeover": true}, nil)
	var sess2 struct {
		PairToken string `json:"pairToken"`
	}
	e.do("POST", "/api/session", "Bearer "+claim2.RefreshToken, map[string]any{"pairId": claim2.PairID}, &sess2)

	// 1) 第二代 pair 的任务列表必须能看到第一代任务
	var list struct {
		Tasks []struct {
			TaskID string `json:"taskId"`
			Status string `json:"status"`
			Title  string `json:"title"`
		} `json:"tasks"`
	}
	resp := e.do("GET", "/api/tasks?pairId="+claim2.PairID, "Bearer "+sess2.PairToken, nil, &list)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("任务列表应 200，实际 %d", resp.StatusCode)
	}
	found := false
	for _, task := range list.Tasks {
		if task.TaskID == "t_"+taskID.String() {
			found = true
			if task.Status != "settled" {
				t.Fatalf("settled 任务不应被改写成 stale，实际 %s", task.Status)
			}
		}
	}
	if !found {
		t.Fatalf("第二代 pair 看不到第一代任务（共 %d 条）：pair 换代不应让任务消失", len(list.Tasks))
	}

	// 3) bridge 带第一代 pairId 上报 task.state → 必须落在第二代（active）ring。
	//    这是 follow_up 旧任务的真实形态：bridge 内存里记的还是旧 pairId。
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
			Name: "dev-1", Workspaces: []string{"/work/a"}})
	raw, _ := protocol.Marshal(hello)
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatal(err)
	}
	if _, _, err := conn.Read(ctx); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for !e.hub.Online(e.deviceID) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}

	stateEnv, _ := protocol.New(protocol.TypeTaskState, time.Now().UnixMilli()).
		WithPayload(map[string]string{"taskId": "t_" + taskID.String(), "status": "running"})
	stateEnv.PairID = claim1.PairID // 旧代
	stateRaw, _ := protocol.Marshal(stateEnv)
	if err := conn.Write(ctx, websocket.MessageText, stateRaw); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)

	active2, _ := model.ParseID(strings.TrimPrefix(claim2.PairID, "p_"))
	active1, _ := model.ParseID(strings.TrimPrefix(claim1.PairID, "p_"))
	if e.hub.LastSeq(active2) < 1 {
		t.Fatalf("旧 pairId 上报的事件必须重路由到 active pair ring（active2 seq=%d）", e.hub.LastSeq(active2))
	}
	_ = active1

	// 4) 历史回看跨代应放行（同 device，bridge 已在线）
	resp = e.do("POST", "/api/history?pairId="+claim2.PairID, "Bearer "+sess2.PairToken,
		map[string]any{"taskId": "t_" + taskID.String()}, nil)
	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("跨代历史回看应放行，实际 %d: %s", resp.StatusCode, b)
	}
	resp.Body.Close()
}
