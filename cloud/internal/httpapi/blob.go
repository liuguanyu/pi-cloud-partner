package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/leon82/pcp/cloud/internal/model"
	"github.com/leon82/pcp/cloud/internal/protocol"
	"github.com/leon82/pcp/cloud/internal/store"
)

// blob 相关常量。
const (
	// maxBlobBytes 单文件上限。nginx 侧 client_max_body_size 是 64m，这里收紧，
	// 因为手机上传的截图/日志通常远小于此，放宽只会浪费磁盘。
	maxBlobBytes = 16 << 20
	// blobTTL 产物保留期，与 SPEC §6 的 7 天一致
	blobTTL = 7 * 24 * 60 * 60 * 1000
	// blobURLTTL 签名链接有效期：<img> 标签带不了 Authorization，只能用签名 URL
	blobURLTTL = 60 * 60 * 1000
)

// signBlobURL 生成 `?e=<过期毫秒>&s=<hmac>`，让浏览器可以直接加载图片。
func (s *Server) signBlobURL(id model.ID, now int64) string {
	expires := now + blobURLTTL
	mac := hmac.New(sha256.New, []byte(s.blobSecret))
	fmt.Fprintf(mac, "%s|%d", id.String(), expires)
	sig := hex.EncodeToString(mac.Sum(nil))[:32]
	return "/blob/" + id.String() + "?e=" + strconv.FormatInt(expires, 10) + "&s=" + sig
}

func (s *Server) verifyBlobSig(id model.ID, expires int64, sig string, now int64) bool {
	if expires < now {
		return false
	}
	mac := hmac.New(sha256.New, []byte(s.blobSecret))
	fmt.Fprintf(mac, "%s|%d", id.String(), expires)
	expected := hex.EncodeToString(mac.Sum(nil))[:32]
	return hmac.Equal([]byte(expected), []byte(sig))
}

// handleBlobUpload 接收手机上传的截图/文件。
//
// 用 multipart 而不是 base64 JSON：base64 会膨胀 33%，且 16MB 的图直接进 JSON
// 会撑爆 wss 帧与内存。所有大对象都走这里，事件流里只传 blobId。
func (s *Server) handleBlobUpload(w http.ResponseWriter, r *http.Request) {
	pairRef := r.URL.Query().Get("pairId")

	// 两种上传者：
	//   手机（pairToken）—— 上传用户附件
	//   bridge（deviceToken）—— 把 agent 产出的图片转存成 blob
	var pairID model.ID
	if pair, err := s.requirePairToken(r, pairRef); err == nil {
		pairID = pair.ID
	} else if dev, derr := s.requireDevice(r); derr == nil {
		target, perr := protocol.ParseRef(pairRef, "p")
		if perr != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "device 上传需要 pairId")
			return
		}
		owned, perr := s.cfg.Store.PairByID(r.Context(), target)
		if perr != nil || owned.DeviceID != dev.ID {
			s.fail(w, errUnauthorized)
			return
		}
		pairID = owned.ID
	} else {
		s.fail(w, errUnauthorized)
		return
	}
	if s.blobDir == "" {
		writeErr(w, http.StatusServiceUnavailable, "blob_disabled", "云端未配置 blob 存储目录")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxBlobBytes+(1<<20))
	if err := r.ParseMultipartForm(maxBlobBytes); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "解析上传失败或文件过大")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "缺少 file 字段")
		return
	}
	defer file.Close()

	raw, err := io.ReadAll(io.LimitReader(file, maxBlobBytes+1))
	if err != nil {
		s.fail(w, err)
		return
	}
	if len(raw) == 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "空文件")
		return
	}
	if len(raw) > maxBlobBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "too_large", "文件超过 16MB")
		return
	}

	sum := sha256.Sum256(raw)
	sha := hex.EncodeToString(sum[:])
	now := s.cfg.Now()
	mime := resolveMime(header.Header.Get("Content-Type"), header.Filename)
	kind := classifyBlob(mime, header.Filename)

	// 同一内容重复上传直接复用（截图/同一份日志反复发很常见）
	if existing, err := s.cfg.Store.BlobBySHA(r.Context(), sha); err == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"blobId":       protocol.RefBlob(existing.ID),
			"kind":         existing.Kind,
			"bytes":        existing.Bytes,
			"name":         header.Filename,
			"mimeType":     header.Header.Get("Content-Type"),
			"deduplicated": true,
		})
		return
	}

	id := model.NewID()
	key := filepath.Join(s.blobDir, id.String())
	if err := os.MkdirAll(s.blobDir, 0o700); err != nil {
		s.fail(w, err)
		return
	}
	if err := os.WriteFile(key, raw, 0o600); err != nil {
		s.fail(w, err)
		return
	}

	blob := model.Blob{
		ID:         id,
		PairID:     pairID,
		Kind:       kind,
		Mime:       mime,
		Name:       header.Filename,
		Bytes:      int64(len(raw)),
		SHA256:     sha,
		StorageKey: key,
		CreatedAt:  now,
		ExpiresAt:  now + blobTTL,
	}
	if err := s.cfg.Store.CreateBlob(r.Context(), blob); err != nil {
		_ = os.Remove(key)
		s.fail(w, err)
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"blobId":   protocol.RefBlob(id),
		"kind":     kind,
		"bytes":    len(raw),
		"name":     header.Filename,
		"mimeType": mime,
		"url":      s.signBlobURL(id, now),
	})
}

// handleBlobGet 提供两种访问方式：
//   - 签名 URL（?e=&s=）：给 <img> 用，浏览器带不了 Authorization
//   - device 凭据：给 bridge 下载手机上传的附件
func (s *Server) handleBlobGet(w http.ResponseWriter, r *http.Request) {
	id, err := model.ParseID(r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "blobId 非法")
		return
	}

	now := s.cfg.Now()
	signed := false
	if e := r.URL.Query().Get("e"); e != "" {
		expires, perr := strconv.ParseInt(e, 10, 64)
		if perr != nil || !s.verifyBlobSig(id, expires, r.URL.Query().Get("s"), now) {
			writeErr(w, http.StatusForbidden, "bad_signature", "链接无效或已过期")
			return
		}
		signed = true
	}

	blob, err := s.cfg.Store.BlobByID(r.Context(), id)
	if err != nil {
		s.fail(w, err)
		return
	}

	if !signed {
		// 未签名时必须带凭据：device（bridge 下载）或该 pair 的 token（手机预览）
		authorized := false
		if dev, derr := s.requireDevice(r); derr == nil {
			pair, perr := s.cfg.Store.PairByID(r.Context(), blob.PairID)
			if perr == nil && pair.DeviceID == dev.ID {
				authorized = true
			}
		} else if _, perr := s.requirePairToken(r, protocol.RefPair(blob.PairID)); perr == nil {
			authorized = true
		}
		if !authorized {
			writeErr(w, http.StatusUnauthorized, "unauthorized", "需要凭据或签名链接")
			return
		}
	}

	data, err := os.ReadFile(blob.StorageKey)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeErr(w, http.StatusGone, "blob_expired", "文件已过期或已清理")
			return
		}
		s.fail(w, err)
		return
	}

	mime := blob.Mime
	if mime == "" {
		mime = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mime)
	if blob.Name != "" {
		w.Header().Set("Content-Disposition", "inline; filename=\""+sanitizeFilename(blob.Name)+"\"")
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("Cache-Control", "private, max-age=600")
	_, _ = w.Write(data)
}

// handleBlobURL 给手机换一个可直接放进 <img src> 的签名链接。
func (s *Server) handleBlobURL(w http.ResponseWriter, r *http.Request) {
	pair, err := s.requirePairToken(r, r.URL.Query().Get("pairId"))
	if err != nil {
		s.fail(w, err)
		return
	}
	id, err := model.ParseID(r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "blobId 非法")
		return
	}
	blob, err := s.cfg.Store.BlobByID(r.Context(), id)
	if err != nil {
		s.fail(w, err)
		return
	}
	if blob.PairID != pair.ID {
		writeErr(w, http.StatusForbidden, "forbidden", "该文件不属于当前配对")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"url":     s.signBlobURL(id, s.cfg.Now()),
		"kind":    blob.Kind,
		"bytes":   blob.Bytes,
		"expires": s.cfg.Now() + blobURLTTL,
	})
}

// resolveMime 决定存下来的 mime。
//
// 浏览器上传时会带上 File.type，但并非总是可靠（有些环境只给
// application/octet-stream）。这时按扩展名兜底——手机端要用 <img src> 直接渲染，
// 存成 octet-stream 就会变成下载而不是显示图片。
func resolveMime(contentType, filename string) string {
	ct := strings.ToLower(strings.TrimSpace(contentType))
	if ct != "" && ct != "application/octet-stream" {
		return ct
	}
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".svg":
		return "image/svg+xml"
	case ".pdf":
		return "application/pdf"
	case ".json":
		return "application/json"
	case ".md":
		return "text/markdown"
	case ".csv":
		return "text/csv"
	case ".txt", ".log":
		return "text/plain"
	case ".zip":
		return "application/zip"
	default:
		return "application/octet-stream"
	}
}

func classifyBlob(contentType, filename string) string {
	ct := strings.ToLower(contentType)
	if strings.HasPrefix(ct, "image/") {
		return "image"
	}
	ext := strings.ToLower(filepath.Ext(filename))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg":
		return "image"
	}
	return "file"
}

// sanitizeFilename 只保留安全字符，避免 Content-Disposition 头注入。
func sanitizeFilename(name string) string {
	base := filepath.Base(name)
	var b strings.Builder
	for _, r := range base {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '.' || r == '-' || r == '_' || r == ' ':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	out := strings.TrimSpace(b.String())
	if out == "" {
		return "blob"
	}
	return out
}

var _ = base64.StdEncoding
var _ = store.ErrNotFound
