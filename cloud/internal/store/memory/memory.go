// Package memory 提供内存版 Store，用于本地开发与单元测试。
//
// 语义与 mysql 实现保持一致（含「一台 device 最多一个 active pair」的唯一约束），
// 区别只是数据不持久化。
package memory

import (
	"context"
	"slices"
	"sync"

	"github.com/leon82/pcp/cloud/internal/model"
	"github.com/leon82/pcp/cloud/internal/store"
)

type Store struct {
	mu      sync.RWMutex
	users   map[model.ID]model.User
	bySub   map[string]model.ID
	devices map[model.ID]model.Device
	tokens  map[model.ID]model.Token
	byHash  map[string]model.ID
	codes   map[string]model.PairCode
	pairs   map[model.ID]model.Pair
	audits  []model.AuditEvent
	tasks   map[model.ID]model.Task
}

func New() *Store {
	return &Store{
		users:   map[model.ID]model.User{},
		bySub:   map[string]model.ID{},
		devices: map[model.ID]model.Device{},
		tokens:  map[model.ID]model.Token{},
		byHash:  map[string]model.ID{},
		codes:   map[string]model.PairCode{},
		pairs:   map[model.ID]model.Pair{},
		tasks:   map[model.ID]model.Task{},
	}
}

var _ store.Store = (*Store)(nil)

func (s *Store) UpsertUser(_ context.Context, ssoSub, displayName string, now int64) (model.User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id, ok := s.bySub[ssoSub]; ok {
		return s.users[id], nil
	}
	u := model.User{ID: model.NewID(), SSOSub: ssoSub, DisplayName: displayName, CreatedAt: now}
	s.users[u.ID] = u
	s.bySub[ssoSub] = u.ID
	return u, nil
}

func (s *Store) UserByID(_ context.Context, id model.ID) (model.User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u, ok := s.users[id]
	if !ok {
		return model.User{}, store.ErrNotFound
	}
	return u, nil
}

func (s *Store) CreateDevice(_ context.Context, d model.Device) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.devices {
		if existing.Fingerprint == d.Fingerprint {
			return store.ErrConflict
		}
	}
	s.devices[d.ID] = d
	return nil
}

func (s *Store) DeviceByID(_ context.Context, id model.ID) (model.Device, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.devices[id]
	if !ok {
		return model.Device{}, store.ErrNotFound
	}
	return d, nil
}

func (s *Store) TouchDevice(_ context.Context, id model.ID, now int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.devices[id]
	if !ok {
		return store.ErrNotFound
	}
	d.LastSeenAt = &now
	s.devices[id] = d
	return nil
}

func (s *Store) CreateToken(_ context.Context, t model.Token) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, dup := s.byHash[t.Hash]; dup {
		return store.ErrConflict
	}
	s.tokens[t.ID] = t
	s.byHash[t.Hash] = t.ID
	return nil
}

func (s *Store) TokenByHash(_ context.Context, hash string) (model.Token, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, ok := s.byHash[hash]
	if !ok {
		return model.Token{}, store.ErrNotFound
	}
	return s.tokens[id], nil
}

func (s *Store) TouchToken(_ context.Context, id model.ID, now int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tokens[id]
	if !ok {
		return store.ErrNotFound
	}
	t.LastUsedAt = &now
	s.tokens[id] = t
	return nil
}

func (s *Store) RevokeToken(_ context.Context, id model.ID, now int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tokens[id]
	if !ok {
		return store.ErrNotFound
	}
	if t.RevokedAt == nil {
		t.RevokedAt = &now
		s.tokens[id] = t
	}
	return nil
}

func (s *Store) RevokeTokensForPair(_ context.Context, pairID model.ID, kinds []model.TokenKind, now int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	pair, ok := s.pairs[pairID]
	if !ok {
		return store.ErrNotFound
	}
	for id, t := range s.tokens {
		if t.SubjectID != pairID && t.SubjectID != pair.UserID {
			continue
		}
		if !slices.Contains(kinds, t.Kind) {
			continue
		}
		if t.RevokedAt == nil {
			t.RevokedAt = &now
			s.tokens[id] = t
		}
	}
	return nil
}

func (s *Store) CreatePairCode(_ context.Context, c model.PairCode) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, dup := s.codes[c.Code]; dup {
		return store.ErrConflict
	}
	s.codes[c.Code] = c
	return nil
}

func (s *Store) PairCodeGet(_ context.Context, code string) (model.PairCode, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, ok := s.codes[code]
	if !ok {
		return model.PairCode{}, store.ErrNotFound
	}
	return c, nil
}

func (s *Store) PairCodeByPair(_ context.Context, pairID model.ID) (model.PairCode, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, c := range s.codes {
		if c.PairID == pairID {
			return c, nil
		}
	}
	return model.PairCode{}, store.ErrNotFound
}

func (s *Store) PairCodeDelete(_ context.Context, code string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.codes, code)
	return nil
}

func (s *Store) CreatePair(_ context.Context, p model.Pair) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.Status == model.PairActive {
		for _, existing := range s.pairs {
			if existing.DeviceID == p.DeviceID && existing.Status == model.PairActive {
				return store.ErrConflict
			}
		}
	}
	s.pairs[p.ID] = p
	return nil
}

func (s *Store) PairByID(_ context.Context, id model.ID) (model.Pair, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.pairs[id]
	if !ok {
		return model.Pair{}, store.ErrNotFound
	}
	return p, nil
}

func (s *Store) ActivePairByDevice(_ context.Context, deviceID model.ID) (*model.Pair, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, p := range s.pairs {
		if p.DeviceID == deviceID && p.Status == model.PairActive {
			out := p
			return &out, nil
		}
	}
	return nil, store.ErrNotFound
}

func (s *Store) PairsByUser(_ context.Context, userID model.ID) ([]model.Pair, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]model.Pair, 0, 4)
	for _, p := range s.pairs {
		if p.UserID == userID {
			out = append(out, p)
		}
	}
	return out, nil
}

func (s *Store) PairsByDevice(_ context.Context, deviceID model.ID) ([]model.Pair, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]model.Pair, 0, 4)
	for _, p := range s.pairs {
		if p.DeviceID == deviceID {
			out = append(out, p)
		}
	}
	return out, nil
}

func (s *Store) SetPairStatus(_ context.Context, id model.ID, status model.PairStatus, now int64, revokedBy model.RevokedBy) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.pairs[id]
	if !ok {
		return store.ErrNotFound
	}
	if status == model.PairActive {
		for otherID, other := range s.pairs {
			if otherID != id && other.DeviceID == p.DeviceID && other.Status == model.PairActive {
				return store.ErrConflict
			}
		}
		p.ApprovedAt = &now
	}
	switch status {
	case model.PairRevoked, model.PairRejected, model.PairExpired:
		if p.RevokedAt == nil {
			p.RevokedAt = &now
		}
		if revokedBy != "" {
			p.RevokedBy = string(revokedBy)
		}
	}
	p.Status = status
	s.pairs[id] = p
	return nil
}

func (s *Store) SetPairUser(_ context.Context, id, userID model.ID) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.pairs[id]
	if !ok {
		return store.ErrNotFound
	}
	p.UserID = userID
	s.pairs[id] = p
	return nil
}

func (s *Store) AppendAudit(_ context.Context, e model.AuditEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	e.ID = uint64(len(s.audits) + 1)
	s.audits = append(s.audits, e)
	return nil
}

func (s *Store) ListAudit(_ context.Context, pairID model.ID, limit int) ([]model.AuditEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]model.AuditEvent, 0, limit)
	for i := len(s.audits) - 1; i >= 0 && len(out) < limit; i-- {
		e := s.audits[i]
		if pairID.IsZero() || (e.PairID != nil && *e.PairID == pairID) {
			out = append(out, e)
		}
	}
	return out, nil
}

func (s *Store) UpsertTask(_ context.Context, t model.Task) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.tasks[t.ID]; ok {
		if t.PairID.IsZero() {
			t.PairID = old.PairID
		}
		if t.Workspace == "" {
			t.Workspace = old.Workspace
		}
		if t.WorkspaceMode == "" {
			t.WorkspaceMode = old.WorkspaceMode
		}
		if t.Status == "" {
			t.Status = old.Status
		}
		if t.Title == "" {
			t.Title = old.Title
		}
		if t.StartedAt == nil {
			t.StartedAt = old.StartedAt
		}
		if t.SettledAt == nil {
			t.SettledAt = old.SettledAt
		}
		if t.ExitReason == "" {
			t.ExitReason = old.ExitReason
		}
		if t.BlobCount == 0 {
			t.BlobCount = old.BlobCount
		}
	}
	s.tasks[t.ID] = t
	return nil
}

func (s *Store) TasksByPair(_ context.Context, pairID model.ID, limit int) ([]model.Task, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]model.Task, 0, limit)
	for _, t := range s.tasks {
		if t.PairID == pairID {
			out = append(out, t)
		}
	}
	slices.SortFunc(out, func(a, b model.Task) int {
		var at, bt int64
		if a.StartedAt != nil {
			at = *a.StartedAt
		}
		if b.StartedAt != nil {
			bt = *b.StartedAt
		}
		switch {
		case at > bt:
			return -1
		case at < bt:
			return 1
		default:
			return 0
		}
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (s *Store) Close() error { return nil }
