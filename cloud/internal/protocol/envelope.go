// Package protocol 实现 protocol/schema/envelope.json 定义的线格式。
//
// 铁律：可选字段一律 `omitempty`，**禁止发送 null**（Go 侧天然满足：零值被省略）。
// 数字一律整数（毫秒时间戳 / 序号），不使用浮点。
package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/leon82/pcp/cloud/internal/model"
)

// Version 是当前协议版本，握手时与客户端比对。
const Version = 1

// Envelope 是所有帧的统一外壳（上下行对称）。
type Envelope struct {
	V       int             `json:"v"`
	Type    string          `json:"type"`
	TS      int64           `json:"ts"`
	PairID  string          `json:"pairId,omitempty"`
	TaskID  string          `json:"taskId,omitempty"`
	RunID   string          `json:"runId,omitempty"`
	Epoch   int             `json:"epoch,omitempty"`
	Seq     int64           `json:"seq,omitempty"`
	CmdID   string          `json:"cmdId,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// 帧类型常量。命名空间见 protocol/schema/task.json 与 control.json 的 x-event-types。
const (
	// 上行（bridge → cloud）
	TypeBridgeHello    = "bridge.hello"
	TypeBridgeWelcome  = "bridge.welcome"
	TypeBridgeCapacity = "bridge.capacity"
	TypeBridgeOnline   = "bridge.online"
	// TypeBridgePing 是应用层保活帧。NAT 与负载均衡会切断空闲连接，
	// 30s 一次足够（实测链路空闲 130s 不断）。云端收到只更新 last_seen，不转发。
	TypeBridgePing    = "bridge.ping"
	TypeBridgeOffline = "bridge.offline"
	TypePiEvent       = "pi.event"
	TypeUIRequest     = "ui.request"
	TypeControlResult = "control.result"
	TypeControlQueued = "control.queued"
	TypeTaskEnqueued  = "task.enqueued"
	TypeTaskStarted   = "task.started"
	TypeTaskSummary   = "task.summary"
	TypeTaskAwaiting  = "task.awaiting_approval"
	TypeTaskSettled   = "task.settled"
	TypeTaskFailed    = "task.failed"
	TypeTaskCancelled = "task.cancelled"
	TypeTaskTitleUpd  = "task.title_updated"

	// 下行（cloud → bridge）
	TypeTaskStart   = "task.start"
	TypeTaskCancel  = "task.cancel"
	TypeTaskInput   = "task.input"
	TypeTaskFocus   = "task.focus"
	TypeControlExec = "control.exec"
	TypeResume      = "resume"
	TypeUIResponse  = "ui.response"
	// TypeHistoryGet 请求某任务的历史正文（正文在 bridge 磁盘）
	TypeHistoryGet = "history.get"
	// TypeHistoryData 是 history.get 的应答
	TypeHistoryData = "history.data"
	// TypeStateSnapshot 是 bridge 重连后的状态对账
	TypeStateSnapshot = "state.snapshot"
	// TypeTaskState 是云端校正后推给手机的任务状态
	TypeTaskState = "task.state"

	// 配对相关（cloud → mobile SSE）
	TypePairApproved  = "pair.approved"
	TypePairRejected  = "pair.rejected"
	TypePairRevoked   = "pair.revoked"
	TypePairContested = "pair.contested"
	TypePairSuspended = "pair.suspended"

	// 云端自身
	TypeServerError = "server.error"
)

// taskScopedTypes 里的事件属于某个 task，必须带 taskId；云端据此做 per-task 游标与分级推送。
var taskScopedTypes = map[string]bool{
	TypePiEvent:       true,
	TypeTaskEnqueued:  true,
	TypeTaskStarted:   true,
	TypeTaskSummary:   true,
	TypeTaskAwaiting:  true,
	TypeTaskSettled:   true,
	TypeTaskFailed:    true,
	TypeTaskCancelled: true,
	TypeTaskTitleUpd:  true,
	TypeUIRequest:     true,
}

// TaskScoped 报告该帧是否需要 taskId 与 seq。
func TaskScoped(frameType string) bool { return taskScopedTypes[frameType] }

// New 构造一个带当前时间戳的信封。
func New(frameType string, now int64) Envelope {
	return Envelope{V: Version, Type: frameType, TS: now}
}

// WithPayload 序列化载荷并挂到信封上。
func (e Envelope) WithPayload(v any) (Envelope, error) {
	if v == nil {
		e.Payload = nil
		return e, nil
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return e, err
	}
	e.Payload = raw
	return e, nil
}

// Marshal 序列化信封。hub 需要它来生成 SSE 数据体。
func Marshal(e Envelope) ([]byte, error) { return json.Marshal(e) }

// Decode 把载荷解到目标结构。
func (e Envelope) Decode(v any) error {
	if len(e.Payload) == 0 {
		return errors.New("frame has no payload")
	}
	return json.Unmarshal(e.Payload, v)
}

// RefPair / RefTask 生成对外的 pair/task 标识。
//
// 用**完整 32 位十六进制**而非截断：schema 的 pattern 是 `^[pt]_[0-9a-f]{8,32}$`，
// 全量 ID 既满足契约，又让云端无需再维护 short → id 映射表。
// 展示层（手机/日志）自行截断前 8 位即可。
func RefPair(id model.ID) string { return "p_" + id.String() }
func RefTask(id model.ID) string { return "t_" + id.String() }

// ParseRef 解析 p_/t_ 前缀的标识，返回 16 字节 ID。
func ParseRef(s, prefix string) (model.ID, error) {
	var zero model.ID
	want := prefix + "_"
	body := strings.TrimPrefix(s, want)
	if body == s {
		return zero, fmt.Errorf("标识 %q 缺少前缀 %q", s, want)
	}
	if len(body) < 8 || len(body) > 32 || len(body)%2 != 0 {
		return zero, fmt.Errorf("标识 %q 长度非法", s)
	}
	// 不足 32 位时右侧补零，保证可反解成 16 字节
	for len(body) < 32 {
		body += "0"
	}
	return model.ParseID(body)
}

// Validate 做最小合法性检查，避免把脏帧转发出去。
func (e Envelope) Validate() error {
	if e.V != Version {
		return errors.New("unsupported protocol version")
	}
	if e.Type == "" {
		return errors.New("missing type")
	}
	if TaskScoped(e.Type) && e.TaskID == "" {
		return errors.New("task-scoped frame requires taskId")
	}
	return nil
}

// BridgeHello 是 bridge 连上后发送的第一帧。
type BridgeHello struct {
	DeviceID    string   `json:"deviceId"`
	Version     int      `json:"version"`
	Workspaces  []string `json:"workspaces,omitempty"`
	Name        string   `json:"name,omitempty"`
	MaxRunning  int      `json:"maxRunning,omitempty"`
	LiveChildrn int      `json:"liveChildren,omitempty"`
}

// BridgeWelcome 是云端对 hello 的应答，告知当前已授权的 pair 列表。
type BridgeWelcome struct {
	Version int      `json:"version"`
	PairIDs []string `json:"pairIds"`
	// ServerTime 让 bridge 能估算时钟偏差，事件排序用
	ServerTime int64 `json:"serverTime"`
}

// Capacity 与 protocol/schema/task.json#/definitions/Capacity 对齐。
type Capacity struct {
	Running         int `json:"running"`
	MaxRunning      int `json:"maxRunning"`
	LiveChildren    int `json:"liveChildren"`
	MaxLiveChildren int `json:"maxLiveChildren"`
	Queued          int `json:"queued,omitempty"`
	MemMB           int `json:"memMB,omitempty"`
	MemLimitMB      int `json:"memLimitMB,omitempty"`
}

// Resume 是断线续传请求：per-task 游标映射。
type Resume struct {
	Cursors map[string]int64 `json:"cursors"`
}

// StateSnapshot 是 bridge 重连后的状态对账载荷。
type StateSnapshot struct {
	Tasks []SnapshotTask `json:"tasks"`
}

type SnapshotTask struct {
	TaskID   string            `json:"taskId"`
	Status   string            `json:"status"`
	Approval *SnapshotApproval `json:"approval,omitempty"`
}

type SnapshotApproval struct {
	RequestID string   `json:"requestId"`
	Method    string   `json:"method"`
	Title     string   `json:"title,omitempty"`
	Message   string   `json:"message,omitempty"`
	Options   []string `json:"options,omitempty"`
	TaskID    string   `json:"taskId"`
}

// UIResponse 回填 pi 的 extension_ui_response。
type UIResponse struct {
	RequestID string          `json:"requestId"`
	Value     json.RawMessage `json:"value,omitempty"`
	Confirmed *bool           `json:"confirmed,omitempty"`
	Cancelled *bool           `json:"cancelled,omitempty"`
}
