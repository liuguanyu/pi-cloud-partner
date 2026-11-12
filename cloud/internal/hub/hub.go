// Package hub 维护「云端瞬时连接状态」：谁在线、事件往哪投、断线后补什么。
//
// 这一层刻意不做持久化 —— 进程重启后所有连接都需要重建，ring buffer 丢掉也无妨
// （手机重连时会带上 per-task 游标，缺口由 bridge 的 deep ring 补足，见 M3）。
//
// 多实例部署时把 ring/在线表换成 Redis pub/sub 即可，接口不变。
package hub

import (
	"errors"
	"sync"

	"github.com/leon82/pcp/cloud/internal/model"
	"github.com/leon82/pcp/cloud/internal/protocol"
)

// ErrBridgeOffline 表示目标设备的 bridge 当前不在线。
var ErrBridgeOffline = errors.New("bridge_offline")

const (
	ringSize        = 1000 // 每个 pair 保留的事件条数
	subscriberQueue = 256  // 单个 SSE 订阅者队列深度
)

// Frame 是一条已序列化的事件，直接写 SSE。
type Frame struct {
	Envelope protocol.Envelope
	JSON     []byte
}

type Bridge struct {
	DeviceID model.ID
	Name     string
	out      chan protocol.Envelope
	done     chan struct{}

	mu         sync.RWMutex
	workspaces []string
	capacity   protocol.Capacity
}

// Out 是发给 bridge 的下行帧通道；bridge 的写协程消费它。
func (b *Bridge) Out() <-chan protocol.Envelope { return b.out }

// Done 在 bridge 被注销时关闭，写协程据此退出。
func (b *Bridge) Done() <-chan struct{} { return b.done }

// Workspaces 返回 bridge 上报的白名单工作目录。
func (b *Bridge) Workspaces() []string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return append([]string(nil), b.workspaces...)
}

// Capacity 返回最近一次上报的容量。
func (b *Bridge) Capacity() protocol.Capacity {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.capacity
}

func (b *Bridge) setCapacity(c protocol.Capacity) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.capacity = c
}

func (b *Bridge) setWorkspaces(ws []string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.workspaces = append([]string(nil), ws...)
}

type subscriber struct {
	ch     chan Frame
	closed bool
}

type pairState struct {
	seq  int64
	ring []Frame
	subs map[*subscriber]struct{}
}

func newPairState() *pairState { return &pairState{subs: map[*subscriber]struct{}{}} }

// Hub 是所有连接的中心表。
type Hub struct {
	mu      sync.RWMutex
	bridges map[model.ID]*Bridge
	pairs   map[model.ID]*pairState

	// OnBridgeOnline / OnBridgeOffline 供上层推送状态事件（可选）
	onBridgeChange func(deviceID model.ID, online bool, name string)
}

func New() *Hub {
	return &Hub{
		bridges: map[model.ID]*Bridge{},
		pairs:   map[model.ID]*pairState{},
	}
}

// OnBridgeChange 注册 bridge 上下线回调（用于给手机推 bridge.online/offline）。
func (h *Hub) OnBridgeChange(fn func(deviceID model.ID, online bool, name string)) {
	h.onBridgeChange = fn
}

// ── bridge 注册 ────────────────────────────────────────────────

// RegisterBridge 注册（或替换）一台设备的连接。重复连接时旧的会被注销并关闭。
func (h *Hub) RegisterBridge(deviceID model.ID, name string, workspaces []string) *Bridge {
	b := &Bridge{
		DeviceID: deviceID,
		Name:     name,
		out:      make(chan protocol.Envelope, 128),
		done:     make(chan struct{}),
	}
	b.setWorkspaces(workspaces)

	h.mu.Lock()
	old := h.bridges[deviceID]
	h.bridges[deviceID] = b
	h.mu.Unlock()

	if old != nil {
		h.unregister(old)
	}
	if h.onBridgeChange != nil {
		h.onBridgeChange(deviceID, true, name)
	}
	return b
}

// UnregisterBridge 注销连接（幂等）。只有当前登记的实例才会生效，避免误删新连接。
func (h *Hub) UnregisterBridge(b *Bridge) {
	h.mu.Lock()
	current := h.bridges[b.DeviceID]
	h.mu.Unlock()
	if current != b {
		return
	}
	h.unregister(b)
	if h.onBridgeChange != nil {
		h.onBridgeChange(b.DeviceID, false, b.Name)
	}
}

func (h *Hub) unregister(b *Bridge) {
	h.mu.Lock()
	if h.bridges[b.DeviceID] == b {
		delete(h.bridges, b.DeviceID)
	}
	h.mu.Unlock()
	select {
	case <-b.done:
	default:
		close(b.done)
	}
}

// Bridge 取在线连接。
func (h *Hub) Bridge(deviceID model.ID) (*Bridge, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	b, ok := h.bridges[deviceID]
	return b, ok
}

// Online 返回设备是否在线。
func (h *Hub) Online(deviceID model.ID) bool {
	_, ok := h.Bridge(deviceID)
	return ok
}

// SetCapacity 更新容量（非阻塞投递给手机）。
func (h *Hub) SetCapacity(b *Bridge, c protocol.Capacity) {
	b.setCapacity(c)
}

// Send 把下行帧投给某设备的 bridge。队列满时返回错误，由调用方转 429/503。
func (h *Hub) Send(deviceID model.ID, env protocol.Envelope) error {
	b, ok := h.Bridge(deviceID)
	if !ok {
		return ErrBridgeOffline
	}
	select {
	case b.out <- env:
		return nil
	default:
		return errors.New("bridge_outbox_full")
	}
}

// ── 事件发布与订阅 ─────────────────────────────────────────────

func (h *Hub) pairLocked(pairID model.ID) *pairState {
	ps, ok := h.pairs[pairID]
	if !ok {
		ps = newPairState()
		h.pairs[pairID] = ps
	}
	return ps
}

// Publish 给事件分配**每 pair 单调递增**的 seq，写入 ring 并分发给订阅者。
//
// 偏差说明（相对 protocol/tasks.md §6 的 per-task seq）：这里用 per-pair 单调 seq。
// 它满足同一个用途且实现更简单 —— 续传时按 `env.TaskID == tid && env.Seq > cursor`
// 过滤即可，同时 SSE 的 `id:` 天然有序。已在文档中记录。
func (h *Hub) Publish(pairID model.ID, env protocol.Envelope, marshal func(protocol.Envelope) ([]byte, error)) Frame {
	h.mu.Lock()
	ps := h.pairLocked(pairID)
	ps.seq++
	env.V = protocol.Version
	env.PairID = protocol.RefPair(pairID)
	env.Seq = ps.seq

	raw, err := marshal(env)
	if err != nil {
		raw = []byte(`{"v":1,"type":"server.error"}`)
	}
	frame := Frame{Envelope: env, JSON: raw}

	ps.ring = append(ps.ring, frame)
	if len(ps.ring) > ringSize {
		ps.ring = ps.ring[len(ps.ring)-ringSize:]
	}

	// 背压策略：队列满就丢弃（丢的是增量，状态类事件会在下一次变化时重发）
	for sub := range ps.subs {
		if sub.closed {
			continue
		}
		select {
		case sub.ch <- frame:
		default:
			// 慢消费者：丢弃本帧，不阻塞其他订阅者
		}
	}
	h.mu.Unlock()
	return frame
}

// Subscribe 订阅某个 pair 的事件流。
func (h *Hub) Subscribe(pairID model.ID) (<-chan Frame, func()) {
	sub := &subscriber{ch: make(chan Frame, subscriberQueue)}

	h.mu.Lock()
	ps := h.pairLocked(pairID)
	ps.subs[sub] = struct{}{}
	h.mu.Unlock()

	unsubscribe := func() {
		h.mu.Lock()
		if ps, ok := h.pairs[pairID]; ok {
			delete(ps.subs, sub)
		}
		if !sub.closed {
			sub.closed = true
			close(sub.ch)
		}
		h.mu.Unlock()
	}
	return sub.ch, unsubscribe
}

// Resume 按 per-task 游标回放缺口。cursors 为空表示只回放最近的一小段。
func (h *Hub) Resume(pairID model.ID, cursors map[string]int64) []Frame {
	h.mu.RLock()
	defer h.mu.RUnlock()
	ps, ok := h.pairs[pairID]
	if !ok {
		return nil
	}
	if len(cursors) == 0 {
		// 没有游标：给最近 50 条，让手机能画出当前状态
		start := len(ps.ring) - 50
		if start < 0 {
			start = 0
		}
		return append([]Frame(nil), ps.ring[start:]...)
	}
	out := make([]Frame, 0, 64)
	for _, f := range ps.ring {
		if f.Envelope.TaskID == "" {
			// pair 级事件（task.created / bridge.capacity 等）总是重放最近部分
			continue
		}
		if cursor, ok := cursors[f.Envelope.TaskID]; ok && f.Envelope.Seq > cursor {
			out = append(out, f)
		}
	}
	return out
}

// LastSeq 返回该 pair 当前最新 seq（用于诊断与健康检查）。
func (h *Hub) LastSeq(pairID model.ID) int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if ps, ok := h.pairs[pairID]; ok {
		return ps.seq
	}
	return 0
}

// Stats 返回连接统计，给 /healthz 与运营排查用。
func (h *Hub) Stats() (bridges int, pairs int) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.bridges), len(h.pairs)
}
