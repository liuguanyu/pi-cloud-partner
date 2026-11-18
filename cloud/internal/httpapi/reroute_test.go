package httpapi_test

import (
	"context"
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
	"github.com/leon82/pcp/cloud/internal/store/memory"
)

// 最小复现：bridge 带旧 pairId 上报，是否落在 active pair 的 ring？
func TestRerouteMinimal(t *testing.T) {
	st := memory.New()
	h := hub.New()
	svc := httpapi.New(httpapi.Config{Store: st, Pairing: pairing.New(st, pairing.DefaultConfig()), Hub: h})
	srv := httptest.NewServer(svc.Handler())
	defer srv.Close()

	now := time.Now().UnixMilli()
	dev := model.Device{ID: model.NewID(), Name: "d", Fingerprint: "fp", CreatedAt: now}
	_ = st.CreateDevice(context.Background(), dev)
	// 两代 pair（takeover 真实顺序）：先 active p1 → revoke p1 → 再 active p2
	p1 := model.Pair{ID: model.NewID(), DeviceID: dev.ID, UserID: model.NewID(), Status: model.PairActive, CreatedAt: now}
	if err := st.CreatePair(context.Background(), p1); err != nil {
		t.Fatalf("create p1: %v", err)
	}
	if err := st.SetPairStatus(context.Background(), p1.ID, model.PairRevoked, now+1, model.RevokedByMobile); err != nil {
		t.Fatalf("revoke p1: %v", err)
	}
	p2 := model.Pair{ID: model.NewID(), DeviceID: dev.ID, UserID: model.NewID(), Status: model.PairActive, CreatedAt: now + 2}
	if err := st.CreatePair(context.Background(), p2); err != nil {
		t.Fatalf("create p2: %v", err)
	}
	// 断言：此时 device 唯一 active pair 是 p2
	ap, err := st.ActivePairByDevice(context.Background(), dev.ID)
	if err != nil || ap == nil || ap.ID != p2.ID {
		t.Fatalf("ActivePairByDevice 应返回 p2，err=%v ap=%v", err, ap)
	}

	tok, hash := auth.NewToken()
	_ = st.CreateToken(context.Background(), model.Token{ID: model.NewID(), Kind: model.TokenDevice, SubjectID: dev.ID, Hash: hash, CreatedAt: now})

	wsURL := strings.Replace(srv.URL, "http://", "ws://", 1) + "/ws/bridge"
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Device " + tok}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	hello, _ := protocol.New(protocol.TypeBridgeHello, now+3).
		WithPayload(protocol.BridgeHello{DeviceID: dev.ID.String(), Version: protocol.Version, Name: "d", Workspaces: []string{"/work/a"}})
	raw, _ := protocol.Marshal(hello)
	_ = conn.Write(ctx, websocket.MessageText, raw)
	_, _, _ = conn.Read(ctx)
	deadline := time.Now().Add(2 * time.Second)
	for !h.Online(dev.ID) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !h.Online(dev.ID) {
		t.Fatal("bridge not online")
	}

	// bridge 带**旧** pairId 上报 task.state
	stateEnv, _ := protocol.New(protocol.TypeTaskState, now+4).
		WithPayload(map[string]string{"taskId": "t_" + model.NewID().String(), "status": "running"})
	stateEnv.PairID = protocol.RefPair(p1.ID) // 旧代
	stateRaw, _ := protocol.Marshal(stateEnv)
	if err := conn.Write(ctx, websocket.MessageText, stateRaw); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)

	t.Logf("active p2 ring lastSeq = %d", h.LastSeq(p2.ID))
	t.Logf("old p1 ring lastSeq = %d", h.LastSeq(p1.ID))
	if h.LastSeq(p2.ID) < 1 {
		t.Fatalf("帧没有落在 active pair ring：p2 seq=%d（重路由失败）", h.LastSeq(p2.ID))
	}
}
