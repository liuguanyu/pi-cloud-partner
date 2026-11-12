package httpapi

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"time"

	"github.com/leon82/pcp/cloud/internal/hub"
	"github.com/leon82/pcp/cloud/internal/model"
	"github.com/leon82/pcp/cloud/internal/protocol"
	"github.com/leon82/pcp/cloud/internal/store"
)

type taskStartBody struct {
	Prompt    string            `json:"prompt"`
	Workspace string            `json:"workspace"`
	Isolation string            `json:"isolation"` // shared | worktree
	Images    []json.RawMessage `json:"images"`
	Title     string            `json:"title"` // 可选：手机端显式命名
}

type taskInputBody struct {
	Text string `json:"text"`
	Mode string `json:"mode"` // steer | follow_up
}

type taskFocusBody struct {
	TaskID string `json:"taskId"`
}

type controlBody struct {
	Name string   `json:"name"`
	Args []string `json:"args"`
	Raw  string   `json:"raw"`
}

type uiRespondBody struct {
	RequestID string          `json:"requestId"`
	Value     json.RawMessage `json:"value"`
	Confirmed *bool           `json:"confirmed"`
	Cancelled *bool           `json:"cancelled"`
}

// handleTaskStart：手机启动任务。云端生成 taskId、落摘要、转发给 bridge。
func (s *Server) handleTaskStart(w http.ResponseWriter, r *http.Request) {
	pair, err := s.requirePairToken(r, r.URL.Query().Get("pairId"))
	if err != nil {
		s.fail(w, err)
		return
	}
	var body taskStartBody
	if err := decode(r, &body); err != nil {
		s.fail(w, err)
		return
	}
	if body.Prompt == "" || body.Workspace == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "prompt 与 workspace 必填")
		return
	}
	isolation := body.Isolation
	if isolation == "" {
		isolation = "shared"
	}
	if isolation != "shared" && isolation != "worktree" {
		writeErr(w, http.StatusBadRequest, "bad_request", "isolation 只能是 shared 或 worktree")
		return
	}

	bridge, ok := s.cfg.Hub.Bridge(pair.DeviceID)
	if !ok {
		s.fail(w, hub.ErrBridgeOffline)
		return
	}
	// workspace 白名单：远程控制绝不能接受任意 cwd
	if allowed := bridge.Workspaces(); len(allowed) > 0 && !containsPath(allowed, body.Workspace) {
		writeErr(w, http.StatusBadRequest, "workspace_not_allowed", "目标目录不在 bridge 的 workspace 白名单内")
		return
	}

	now := s.cfg.Now()
	taskID := model.NewID()
	title := body.Title
	if title == "" {
		title = weakTitle(body.Workspace, now)
	}

	// 云端只存摘要：workspace / 状态 / 标题，不含 prompt 正文
	_ = s.cfg.Store.UpsertTask(r.Context(), model.Task{
		ID:            taskID,
		PairID:        pair.ID,
		Workspace:     body.Workspace,
		WorkspaceMode: isolation,
		Status:        "queued",
		Title:         title,
	})

	env, err := protocol.New(protocol.TypeTaskStart, now).WithPayload(map[string]any{
		"prompt":    body.Prompt,
		"workspace": body.Workspace,
		"isolation": isolation,
		"images":    body.Images,
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	env.PairID = protocol.RefPair(pair.ID)
	env.TaskID = protocol.RefTask(taskID)

	if err := s.cfg.Hub.Send(pair.DeviceID, env); err != nil {
		s.fail(w, err)
		return
	}

	// 云端先确认「已接受」，bridge 稍后回 task.started/settled
	frame, _ := protocol.New(protocol.TypeTaskEnqueued, now).WithPayload(map[string]any{
		"taskId":    protocol.RefTask(taskID),
		"title":     title,
		"workspace": body.Workspace,
	})
	s.cfg.Hub.Publish(pair.ID, frame, protocol.Marshal)

	writeJSON(w, http.StatusAccepted, map[string]any{
		"taskId": protocol.RefTask(taskID),
		"title":  title,
		"status": "queued",
	})
}

func (s *Server) handleTaskInput(w http.ResponseWriter, r *http.Request) {
	pair, err := s.requirePairToken(r, r.URL.Query().Get("pairId"))
	if err != nil {
		s.fail(w, err)
		return
	}
	var body taskInputBody
	if err := decode(r, &body); err != nil {
		s.fail(w, err)
		return
	}
	mode := body.Mode
	if mode != "steer" && mode != "follow_up" {
		writeErr(w, http.StatusBadRequest, "bad_request", "mode 只能是 steer 或 follow_up")
		return
	}
	taskRef := r.PathValue("taskId")
	env, err := protocol.New(protocol.TypeTaskInput, s.cfg.Now()).WithPayload(map[string]any{
		"taskId": taskRef,
		"text":   body.Text,
		"mode":   mode,
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	env.PairID = protocol.RefPair(pair.ID)
	env.TaskID = taskRef
	if err := s.cfg.Hub.Send(pair.DeviceID, env); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "accepted"})
}

func (s *Server) handleTaskCancel(w http.ResponseWriter, r *http.Request) {
	pair, err := s.requirePairToken(r, r.URL.Query().Get("pairId"))
	if err != nil {
		s.fail(w, err)
		return
	}
	taskRef := r.PathValue("taskId")
	env, _ := protocol.New(protocol.TypeTaskCancel, s.cfg.Now()).WithPayload(map[string]string{"taskId": taskRef})
	env.PairID = protocol.RefPair(pair.ID)
	env.TaskID = taskRef
	if err := s.cfg.Hub.Send(pair.DeviceID, env); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "accepted"})
}

// handleTaskFocus：切换「聚焦任务」，bridge 据此决定推全量 delta 还是只推摘要。
func (s *Server) handleTaskFocus(w http.ResponseWriter, r *http.Request) {
	pair, err := s.requirePairToken(r, r.URL.Query().Get("pairId"))
	if err != nil {
		s.fail(w, err)
		return
	}
	var body taskFocusBody
	if err := decode(r, &body); err != nil {
		s.fail(w, err)
		return
	}
	env, _ := protocol.New(protocol.TypeTaskFocus, s.cfg.Now()).WithPayload(map[string]string{"taskId": body.TaskID})
	env.PairID = protocol.RefPair(pair.ID)
	env.TaskID = body.TaskID
	if err := s.cfg.Hub.Send(pair.DeviceID, env); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "accepted"})
}

func (s *Server) handleControl(w http.ResponseWriter, r *http.Request) {
	pair, err := s.requirePairToken(r, r.URL.Query().Get("pairId"))
	if err != nil {
		s.fail(w, err)
		return
	}
	var body controlBody
	if err := decode(r, &body); err != nil {
		s.fail(w, err)
		return
	}
	env, _ := protocol.New(protocol.TypeControlExec, s.cfg.Now()).WithPayload(map[string]any{
		"name": body.Name,
		"args": body.Args,
		"raw":  body.Raw,
	})
	env.PairID = protocol.RefPair(pair.ID)
	env.CmdID = model.NewID().String()
	if err := s.cfg.Hub.Send(pair.DeviceID, env); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "accepted"})
}

// handleUIRespond：把手机的审批结果回填成 pi 的 extension_ui_response。
func (s *Server) handleUIRespond(w http.ResponseWriter, r *http.Request) {
	pair, err := s.requirePairToken(r, r.URL.Query().Get("pairId"))
	if err != nil {
		s.fail(w, err)
		return
	}
	var body uiRespondBody
	if err := decode(r, &body); err != nil {
		s.fail(w, err)
		return
	}
	env, _ := protocol.New(protocol.TypeUIResponse, s.cfg.Now()).WithPayload(protocol.UIResponse{
		RequestID: body.RequestID,
		Value:     body.Value,
		Confirmed: body.Confirmed,
		Cancelled: body.Cancelled,
	})
	env.PairID = protocol.RefPair(pair.ID)
	if err := s.cfg.Hub.Send(pair.DeviceID, env); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "accepted"})
}

// handleTaskList：返回云端摘要（bridge 离线也能看到最近任务）。
func (s *Server) handleTaskList(w http.ResponseWriter, r *http.Request) {
	pair, err := s.requirePairToken(r, r.URL.Query().Get("pairId"))
	if err != nil {
		s.fail(w, err)
		return
	}
	tasks, err := s.cfg.Store.TasksByPair(r.Context(), pair.ID, 50)
	if err != nil && err != store.ErrNotFound {
		s.fail(w, err)
		return
	}
	out := make([]map[string]any, 0, len(tasks))
	for _, t := range tasks {
		view := map[string]any{
			"taskId":    protocol.RefTask(t.ID),
			"status":    t.Status,
			"title":     t.Title,
			"workspace": t.Workspace,
			"isolation": t.WorkspaceMode,
		}
		if t.StartedAt != nil {
			view["startedAt"] = *t.StartedAt
		}
		if t.SettledAt != nil {
			view["settledAt"] = *t.SettledAt
		}
		if t.ExitReason != "" {
			view["exitReason"] = t.ExitReason
		}
		out = append(out, view)
	}
	writeJSON(w, http.StatusOK, map[string]any{"tasks": out})
}

// handleWorkspaces 返回 bridge 上报的 workspace 白名单，供手机端做选择器。
// 手机不知道本机目录结构，没有这个接口就只能让用户手打绝对路径。
func (s *Server) handleWorkspaces(w http.ResponseWriter, r *http.Request) {
	pair, err := s.requirePairToken(r, r.URL.Query().Get("pairId"))
	if err != nil {
		s.fail(w, err)
		return
	}
	bridge, online := s.cfg.Hub.Bridge(pair.DeviceID)
	if !online {
		writeJSON(w, http.StatusOK, map[string]any{"online": false, "workspaces": []string{}})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"online":     true,
		"workspaces": bridge.Workspaces(),
		"capacity":   bridge.Capacity(),
	})
}

// ── 小工具 ────────────────────────────────────────────────────

func containsPath(allowed []string, want string) bool {
	for _, a := range allowed {
		if a == want || filepath.Clean(a) == filepath.Clean(want) {
			return true
		}
	}
	return false
}

// weakTitle 生成「派生弱标题」：不含任何用户输入，可安全存云端。
func weakTitle(workspace string, nowMs int64) string {
	base := filepath.Base(filepath.Clean(workspace))
	if base == "/" || base == "." || base == "" {
		base = "workspace"
	}
	return base + " · " + time.UnixMilli(nowMs).Format("01-02 15:04")
}
