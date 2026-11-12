package hub_test

import (
	"testing"
	"time"

	"github.com/leon82/pcp/cloud/internal/hub"
	"github.com/leon82/pcp/cloud/internal/model"
	"github.com/leon82/pcp/cloud/internal/protocol"
)

func taskFrame(taskRef string) protocol.Envelope {
	env, _ := protocol.New(protocol.TypePiEvent, 1).WithPayload(map[string]string{"type": "message_update"})
	env.TaskID = taskRef
	return env
}

// 核心契约：seq 在同一个 pair 内单调递增，且被写进信封。
func TestPublishAssignsMonotonicSeq(t *testing.T) {
	h := hub.New()
	pairID := model.NewID()

	var last int64
	for i := 0; i < 5; i++ {
		frame := h.Publish(pairID, taskFrame(protocol.RefTask(model.NewID())), protocol.Marshal)
		if frame.Envelope.Seq != last+1 {
			t.Fatalf("第 %d 帧 seq = %d，期望 %d", i, frame.Envelope.Seq, last+1)
		}
		last = frame.Envelope.Seq
	}
	// 不同 pair 各自从 1 开始
	other := h.Publish(model.NewID(), taskFrame("t_aaaa"), protocol.Marshal)
	if other.Envelope.Seq != 1 {
		t.Fatalf("新 pair 的 seq 应从 1 开始，实际 %d", other.Envelope.Seq)
	}
}

func TestSubscribeReceivesFrames(t *testing.T) {
	h := hub.New()
	pairID := model.NewID()
	ch, unsubscribe := h.Subscribe(pairID)
	defer unsubscribe()

	h.Publish(pairID, taskFrame("t_1"), protocol.Marshal)

	select {
	case frame := <-ch:
		if frame.Envelope.Type != protocol.TypePiEvent {
			t.Fatalf("事件类型错误: %s", frame.Envelope.Type)
		}
		if len(frame.JSON) == 0 {
			t.Fatal("帧 JSON 不应为空")
		}
	case <-time.After(time.Second):
		t.Fatal("订阅者未收到事件")
	}
}

func TestResumeByCursors(t *testing.T) {
	h := hub.New()
	pairID := model.NewID()
	taskA := protocol.RefTask(model.NewID())
	taskB := protocol.RefTask(model.NewID())

	// A 两帧，B 一帧，交错发布
	fa1 := h.Publish(pairID, taskFrame(taskA), protocol.Marshal)
	_ = h.Publish(pairID, taskFrame(taskB), protocol.Marshal)
	fa2 := h.Publish(pairID, taskFrame(taskA), protocol.Marshal)

	// 手机说「taskA 我看到 fa1 了，taskB 我一条没看到」
	frames := h.Resume(pairID, map[string]int64{
		taskA: fa1.Envelope.Seq,
		taskB: 0,
	})
	if len(frames) != 2 {
		t.Fatalf("应回放 2 帧（A 的第二帧 + B 的全部），实际 %d", len(frames))
	}
	// 回放必须按 seq 升序（B 的 seq=2 在 A 的缺口 seq=3 之前）
	if frames[0].Envelope.Seq != 2 {
		t.Fatalf("首帧应按序是 taskB 那条（seq=2），实际 seq=%d", frames[0].Envelope.Seq)
	}
	if frames[1].Envelope.Seq != fa2.Envelope.Seq {
		t.Fatalf("第二帧应是 taskA 的缺口（seq=%d），实际 seq=%d", fa2.Envelope.Seq, frames[1].Envelope.Seq)
	}
}

func TestBridgeSendAndOffline(t *testing.T) {
	h := hub.New()
	deviceID := model.NewID()

	if err := h.Send(deviceID, taskFrame("t_1")); err != hub.ErrBridgeOffline {
		t.Fatalf("未注册时应返回 ErrBridgeOffline，实际 %v", err)
	}

	bridge := h.RegisterBridge(deviceID, "dev", []string{"/work/a"})
	if !h.Online(deviceID) {
		t.Fatal("注册后应在线")
	}
	if err := h.Send(deviceID, taskFrame("t_1")); err != nil {
		t.Fatalf("发送失败: %v", err)
	}
	select {
	case env := <-bridge.Out():
		if env.TaskID != "t_1" {
			t.Fatalf("下行帧 taskId 错误: %s", env.TaskID)
		}
	case <-time.After(time.Second):
		t.Fatal("bridge 未收到下行帧")
	}

	h.UnregisterBridge(bridge)
	if h.Online(deviceID) {
		t.Fatal("注销后应离线")
	}
	select {
	case <-bridge.Done():
	case <-time.After(time.Second):
		t.Fatal("注销后 Done 应关闭")
	}
}

// 重复连接时旧连接必须被替换，避免同一设备双写。
func TestRegisterReplacesOldBridge(t *testing.T) {
	h := hub.New()
	deviceID := model.NewID()
	oldBridge := h.RegisterBridge(deviceID, "old", nil)
	newBridge := h.RegisterBridge(deviceID, "new", nil)

	select {
	case <-oldBridge.Done():
	case <-time.After(time.Second):
		t.Fatal("旧连接应被关闭")
	}
	if err := h.Send(deviceID, taskFrame("t_1")); err != nil {
		t.Fatalf("新连接应可发送: %v", err)
	}
	select {
	case <-newBridge.Out():
	case <-time.After(time.Second):
		t.Fatal("新连接未收到帧")
	}
}

// 慢消费者不能拖住其他订阅者（丢帧而非阻塞）。
func TestSlowConsumerDoesNotBlock(t *testing.T) {
	h := hub.New()
	pairID := model.NewID()
	slow, unsubSlow := h.Subscribe(pairID)
	fast, unsubFast := h.Subscribe(pairID)
	defer unsubSlow()
	defer unsubFast()

	done := make(chan struct{})
	go func() {
		for i := 0; i < 2000; i++ {
			h.Publish(pairID, taskFrame("t_1"), protocol.Marshal)
		}
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("发布被慢消费者阻塞了")
	}

	// fast 也在收，但没人读 slow —— 关键是不 panic 不阻塞
	received := 0
	for {
		select {
		case <-fast:
			received++
			continue
		default:
		}
		break
	}
	if received == 0 {
		t.Fatal("正常订阅者应收到事件")
	}
	_ = slow
}
