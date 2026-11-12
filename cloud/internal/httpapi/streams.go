package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/leon82/pcp/cloud/internal/hub"
	"github.com/leon82/pcp/cloud/internal/model"
	"github.com/leon82/pcp/cloud/internal/protocol"
	"github.com/leon82/pcp/cloud/internal/store"
)

// heartbeat 必须小于链路上的 idle timeout。
// 实测 lab.leon82.com 链路空闲 130s 不断，30s 心跳留足了余量。
const heartbeatInterval = 30 * time.Second

// handleSSE 是手机下行：一条连接承载该 pair 下所有任务的事件（多路复用）。
//
// 为什么不用 Last-Event-ID：它只能带一个值，而我们是 per-task 游标。
// 这里用 `cursors` 查询参数（JSON: {"t_xxx":123}）。
func (s *Server) handleSSE(w http.ResponseWriter, r *http.Request) {
	pair, err := s.requirePairToken(r, r.URL.Query().Get("pairId"))
	if err != nil {
		s.fail(w, err)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "internal", "响应不支持流式输出")
		return
	}

	var cursors map[string]int64
	if raw := r.URL.Query().Get("cursors"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &cursors); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "cursors 必须是 {taskId: seq} 的 JSON")
			return
		}
	}

	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no") // 关键：禁止 nginx 攒事件
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ctx := r.Context()

	// 1) 先补缺口，再进入实时流。顺序不能反，否则新事件会插到回放前面。
	for _, frame := range s.cfg.Hub.Resume(pair.ID, cursors) {
		if err := writeSSE(w, flusher, frame); err != nil {
			return
		}
	}

	// 2) 握手事件：告诉手机当前游标与 bridge 状态
	helloPayload, _ := json.Marshal(map[string]any{
		"pairId":   protocol.RefPair(pair.ID),
		"lastSeq":  s.cfg.Hub.LastSeq(pair.ID),
		"bridgeOn": s.cfg.Hub.Online(pair.DeviceID),
		"serverTS": s.cfg.Now(),
	})
	if _, err := fmt.Fprintf(w, "event: stream.hello\ndata: %s\n\n", helloPayload); err != nil {
		return
	}
	flusher.Flush()

	ch, unsubscribe := s.cfg.Hub.Subscribe(pair.ID)
	defer unsubscribe()

	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case frame, ok := <-ch:
			if !ok {
				return
			}
			if err := writeSSE(w, flusher, frame); err != nil {
				return
			}
		case <-ticker.C:
			// SSE 注释行既是心跳也是 Nginx 的活跃信号
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func writeSSE(w io.Writer, flusher http.Flusher, frame hub.Frame) error {
	_, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", frame.Envelope.Seq, frame.Envelope.Type, frame.JSON)
	if err != nil {
		return err
	}
	flusher.Flush()
	return nil
}

// handleBridgeWS 是 bridge 长连接。bridge 主动外连，云端不主动拨号。
func (s *Server) handleBridgeWS(w http.ResponseWriter, r *http.Request) {
	dev, err := s.requireDevice(r)
	if err != nil {
		s.fail(w, err)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// bridge 是 Go/Node 客户端，不带 Origin；手机走 SSE 不经过这里
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		s.cfg.Log.Warn("ws accept failed", "err", err, "device", dev.ID.String())
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(4 << 20)

	ctx := r.Context()

	// 首帧必须是 bridge.hello，否则拒绝了也不给任何信息
	helloCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	env, err := readEnvelope(helloCtx, conn)
	cancel()
	if err != nil {
		_ = conn.Close(websocket.StatusPolicyViolation, "expected bridge.hello")
		return
	}
	if env.Type != protocol.TypeBridgeHello {
		_ = conn.Close(websocket.StatusPolicyViolation, "first frame must be bridge.hello")
		return
	}
	var hello protocol.BridgeHello
	if err := env.Decode(&hello); err != nil {
		_ = conn.Close(websocket.StatusPolicyViolation, "malformed bridge.hello")
		return
	}
	if hello.Version != protocol.Version {
		_ = conn.Close(websocket.StatusPolicyViolation, "protocol version mismatch")
		return
	}

	bridge := s.cfg.Hub.RegisterBridge(dev.ID, hello.Name, hello.Workspaces)
	defer s.cfg.Hub.UnregisterBridge(bridge)
	s.cfg.Log.Info("bridge online", "device", dev.ID.String(), "name", hello.Name, "workspaces", len(hello.Workspaces))

	// 已生效的 pair，bridge 需要用它们建立路由表
	pairs, _ := s.cfg.Store.PairsByDevice(ctx, dev.ID)
	pairRefs := make([]string, 0, len(pairs))
	for _, p := range pairs {
		if p.Status == model.PairActive || p.Status == model.PairSuspended {
			pairRefs = append(pairRefs, protocol.RefPair(p.ID))
		}
	}
	welcome, _ := protocol.New(protocol.TypeBridgeWelcome, s.cfg.Now()).WithPayload(protocol.BridgeWelcome{
		Version:    protocol.Version,
		PairIDs:    pairRefs,
		ServerTime: s.cfg.Now(),
	})
	if err := writeEnvelope(ctx, conn, welcome); err != nil {
		return
	}

	// 下行写协程
	writeErrCh := make(chan error, 1)
	go func() {
		for {
			select {
			case <-bridge.Done():
				return
			case out := <-bridge.Out():
				wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
				err := writeEnvelope(wctx, conn, out)
				wcancel()
				if err != nil {
					select {
					case writeErrCh <- err:
					default:
					}
					return
				}
			}
		}
	}()

	// 上行读循环
	readErrCh := make(chan error, 1)
	go func() {
		for {
			in, err := readEnvelope(ctx, conn)
			if err != nil {
				readErrCh <- err
				return
			}
			s.ingestBridgeFrame(ctx, dev, in)
		}
	}()

	select {
	case <-ctx.Done():
	case err := <-writeErrCh:
		s.cfg.Log.Info("bridge write closed", "device", dev.ID.String(), "err", err)
	case err := <-readErrCh:
		if !errors.Is(err, io.EOF) && !strings.Contains(err.Error(), "closed") {
			s.cfg.Log.Info("bridge read closed", "device", dev.ID.String(), "err", err)
		}
	}
	s.cfg.Log.Info("bridge offline", "device", dev.ID.String())
}

func readEnvelope(ctx context.Context, conn *websocket.Conn) (protocol.Envelope, error) {
	var env protocol.Envelope
	typ, data, err := conn.Read(ctx)
	if err != nil {
		return env, err
	}
	if typ != websocket.MessageText {
		return env, errors.New("binary frames not supported")
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return env, err
	}
	return env, nil
}

func writeEnvelope(ctx context.Context, conn *websocket.Conn, env protocol.Envelope) error {
	raw, err := protocol.Marshal(env)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, raw)
}

// ingestBridgeFrame 把 bridge 上报的帧转发给手机，并顺手维护任务摘要。
func (s *Server) ingestBridgeFrame(ctx context.Context, dev model.Device, env protocol.Envelope) {
	if env.V != protocol.Version {
		return
	}

	switch env.Type {
	case protocol.TypeBridgeCapacity:
		var cap protocol.Capacity
		if err := env.Decode(&cap); err == nil {
			if b, ok := s.cfg.Hub.Bridge(dev.ID); ok {
				s.cfg.Hub.SetCapacity(b, cap)
			}
		}
	case protocol.TypePairApproved, protocol.TypePairRevoked, protocol.TypePairRejected:
		// bridge 也能发起撤销，转发即可
	}

	pairID, err := protocol.ParseRef(env.PairID, "p")
	if err != nil {
		s.cfg.Log.Warn("bridge frame without usable pairId", "type", env.Type)
		return
	}
	// 防越权：bridge 只能给属于自己设备的 pair 发事件
	if pair, err := s.cfg.Store.PairByID(ctx, pairID); err != nil || pair.DeviceID != dev.ID {
		s.cfg.Log.Warn("bridge frame for foreign pair", "type", env.Type, "pair", env.PairID)
		return
	}

	s.cfg.Hub.Publish(pairID, env, protocol.Marshal)
	s.trackTask(ctx, pairID, env)
}

// trackTask 维护云端任务摘要（不含正文）。失败不影响转发。
func (s *Server) trackTask(ctx context.Context, pairID model.ID, env protocol.Envelope) {
	if env.TaskID == "" {
		return
	}
	taskID, err := protocol.ParseRef(env.TaskID, "t")
	if err != nil {
		return
	}
	now := s.cfg.Now()

	var status, exitReason string
	var title string
	switch env.Type {
	case protocol.TypeTaskStarted:
		status = "running"
	case protocol.TypeTaskAwaiting:
		status = "awaiting_approval"
	case protocol.TypeTaskSettled:
		status = "settled"
	case protocol.TypeTaskFailed:
		status = "failed"
	case protocol.TypeTaskCancelled:
		status = "cancelled"
	case protocol.TypeTaskEnqueued:
		status = "queued"
	case protocol.TypeTaskTitleUpd:
		var payload struct {
			Title  string `json:"title"`
			Source string `json:"source"`
		}
		if env.Decode(&payload) == nil && payload.Title != "" {
			title = payload.Title
		}
	default:
		return
	}

	var payload struct {
		ExitReason string `json:"exitReason"`
	}
	if len(env.Payload) > 0 {
		_ = env.Decode(&payload)
	}
	exitReason = payload.ExitReason

	task := model.Task{
		ID:         taskID,
		PairID:     pairID,
		Status:     status,
		ExitReason: exitReason,
		Title:      title,
	}
	if status == "running" {
		task.StartedAt = &now
	}
	if status == "settled" || status == "failed" || status == "cancelled" {
		task.SettledAt = &now
	}
	if err := s.cfg.Store.UpsertTask(ctx, task); err != nil && !errors.Is(err, store.ErrNotFound) {
		s.cfg.Log.Warn("track task failed", "err", err, "task", env.TaskID)
	}
}

// handleHealth 给运维与探活用。
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	bridges, pairs := s.cfg.Hub.Stats()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"version": protocol.Version,
		"bridges": bridges,
		"pairs":   pairs,
		"ts":      s.cfg.Now(),
	})
}
