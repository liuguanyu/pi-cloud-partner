package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"github.com/leon82/pcp/cloud/internal/auth"
	"github.com/leon82/pcp/cloud/internal/httpapi"
	"github.com/leon82/pcp/cloud/internal/hub"
	"github.com/leon82/pcp/cloud/internal/model"
	"github.com/leon82/pcp/cloud/internal/pairing"
	"github.com/leon82/pcp/cloud/internal/store/memory"
)

// 带 blob 配置的测试环境
func newBlobEnv(t *testing.T) (*httptest.Server, *memory.Store, *hub.Hub, string, string, string) {
	t.Helper()
	st := memory.New()
	h := hub.New()
	svc := httpapi.New(httpapi.Config{
		Store:      st,
		Pairing:    pairing.New(st, pairing.DefaultConfig()),
		Hub:        h,
		BlobDir:    t.TempDir(),
		BlobSecret: "test-secret",
	})
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)

	now := time.Now().UnixMilli()
	user, err := st.UpsertUser(context.Background(), "tester", "tester", now)
	if err != nil {
		t.Fatal(err)
	}
	dev := createTestDevice(t, st, "dev-blob", now)
	devTok := mintTestToken(t, st, dev.ID, "device", now)

	// 直接建一个 active pair，省掉配对流程
	pairID := model.NewID()
	pairMust(t, st, pairID, dev.ID, user.ID, now)
	pairTok := mintTestToken(t, st, pairID, "pair", now)
	return srv, st, h, devTok, pairTok, "p_" + pairID.String()
}

func TestBlobUploadAndSignedDownload(t *testing.T) {
	srv, _, _, devTok, pairTok, pairRef := newBlobEnv(t)
	content := []byte("hello blob 内容 12345")

	// 1) 上传（两次：第二次应命中去重）
	first := uploadBlob(t, srv, pairTok, pairRef, "note.txt", "text/plain", content)
	if first["deduplicated"] == true {
		t.Fatal("首次上传不应被判为重复")
	}
	second := uploadBlob(t, srv, pairTok, pairRef, "note.txt", "text/plain", content)
	if second["deduplicated"] != true {
		t.Fatal("相同内容应去重")
	}
	blobRef, _ := first["blobId"].(string)
	if !strings.HasPrefix(blobRef, "b_") {
		t.Fatalf("blobId 格式错误: %q", blobRef)
	}

	// 2) 无凭据无签名 → 401
	resp, err := http.Get(srv.URL + "/blob/" + strings.TrimPrefix(blobRef, "b_"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("无凭据应 401，实际 %d", resp.StatusCode)
	}

	// 3) 手机换签名链接 → <img> 可直接加载
	url := blobURL(t, srv, pairTok, pairRef, blobRef)
	signed, err := http.Get(srv.URL + url)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(signed.Body)
	signed.Body.Close()
	if signed.StatusCode != http.StatusOK {
		t.Fatalf("签名链接应 200，实际 %d", signed.StatusCode)
	}
	if !bytes.Equal(body, content) {
		t.Fatalf("内容不一致")
	}
	if ct := signed.Header.Get("Content-Type"); ct != "text/plain" {
		t.Fatalf("Content-Type 应保留上传时的类型，实际 %q", ct)
	}

	// 4) bridge 用 device 凭据下载
	req, _ := http.NewRequest("GET", srv.URL+"/blob/"+strings.TrimPrefix(blobRef, "b_"), nil)
	req.Header.Set("Authorization", "Device "+devTok)
	devResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	devBody, _ := io.ReadAll(devResp.Body)
	devResp.Body.Close()
	if devResp.StatusCode != http.StatusOK || !bytes.Equal(devBody, content) {
		t.Fatalf("device 下载失败 status=%d", devResp.StatusCode)
	}

	// 5) 篡改签名 → 403
	bad := strings.Replace(url, "s=", "s=deadbeef", 1)
	badResp, err := http.Get(srv.URL + bad)
	if err != nil {
		t.Fatal(err)
	}
	badResp.Body.Close()
	if badResp.StatusCode != http.StatusForbidden {
		t.Fatalf("伪造签名应 403，实际 %d", badResp.StatusCode)
	}
}

// 声明为 octet-stream 时按扩展名兜底，否则手机端 <img> 会变成下载
func TestBlobMimeFallbackByExtension(t *testing.T) {
	srv, _, _, _, pairTok, pairRef := newBlobEnv(t)
	got := uploadBlob(t, srv, pairTok, pairRef, "shot.png", "application/octet-stream", []byte("fake-png-bytes"))
	if got["kind"] != "image" {
		t.Fatalf("png 应判为 image，实际 %v", got["kind"])
	}
	if got["mimeType"] != "image/png" {
		t.Fatalf("mime 应按扩展名兜底为 image/png，实际 %v", got["mimeType"])
	}
}

// bridge 用 device 凭据上传（agent 产出的图片转存），归属到该 device 的 pair
func TestBlobUploadByDevice(t *testing.T) {
	srv, _, _, devTok, _, pairRef := newBlobEnv(t)
	content := []byte("agent 产出的图")

	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", `form-data; name="file"; filename="agent-shot.png"`)
	header.Set("Content-Type", "image/png")
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(content)
	writer.Close()

	req, _ := http.NewRequest("POST", fmt.Sprintf("%s/api/blob?pairId=%s", srv.URL, pairRef), &buf)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Device "+devTok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("device 上传应 201，实际 %d: %s", resp.StatusCode, b)
	}
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if ref, _ := out["blobId"].(string); !strings.HasPrefix(ref, "b_") {
		t.Fatalf("blobId 格式错误: %v", out["blobId"])
	}
}

func TestBlobRejectsOversize(t *testing.T) {
	srv, _, _, _, pairTok, pairRef := newBlobEnv(t)
	big := bytes.Repeat([]byte("x"), 16<<20+1024)
	resp := doUpload(t, srv, pairTok, pairRef, "big.bin", "application/octet-stream", big)
	if resp.StatusCode != http.StatusRequestEntityTooLarge && resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("超大文件应被拒，实际 %d", resp.StatusCode)
	}
}

// ── helpers ──────────────────────────────────────────────────

func createTestDevice(t *testing.T, st *memory.Store, name string, now int64) model.Device {
	t.Helper()
	d := model.Device{ID: model.NewID(), Name: name, Fingerprint: "fp-" + name, CreatedAt: now}
	if err := st.CreateDevice(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	return d
}

func mintTestToken(t *testing.T, st *memory.Store, subject model.ID, kind string, now int64) string {
	t.Helper()
	plain, hash := auth.NewToken()
	if err := st.CreateToken(context.Background(), model.Token{
		ID: model.NewID(), Kind: model.TokenKind(kind), SubjectID: subject, Hash: hash, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	return plain
}

func pairMust(t *testing.T, st *memory.Store, pairID, devID, userID model.ID, now int64) model.Pair {
	t.Helper()
	p := model.Pair{ID: pairID, DeviceID: devID, UserID: userID, Status: model.PairActive, CreatedAt: now}
	if err := st.CreatePair(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	return p
}

func uploadBlob(t *testing.T, srv *httptest.Server, pairTok, pairRef, name, mime string, data []byte) map[string]any {
	t.Helper()
	resp := doUpload(t, srv, pairTok, pairRef, name, mime, data)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("上传失败 %d: %s", resp.StatusCode, body)
	}
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

func doUpload(t *testing.T, srv *httptest.Server, pairTok, pairRef, name, mime string, data []byte) *http.Response {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	// 显式带上部件 Content-Type：浏览器会填 File.type，CreateFormFile 只会给 octet-stream
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, name))
	header.Set("Content-Type", mime)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	writer.Close()

	req, err := http.NewRequest("POST", fmt.Sprintf("%s/api/blob?pairId=%s", srv.URL, pairRef), &buf)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+pairTok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func blobURL(t *testing.T, srv *httptest.Server, pairTok, pairRef, blobRef string) string {
	t.Helper()
	req, _ := http.NewRequest("GET",
		fmt.Sprintf("%s/api/blob/%s/url?pairId=%s", srv.URL, strings.TrimPrefix(blobRef, "b_"), pairRef), nil)
	req.Header.Set("Authorization", "Bearer "+pairTok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("换签名链接失败 %d: %s", resp.StatusCode, body)
	}
	var out struct {
		URL string `json:"url"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if out.URL == "" {
		t.Fatal("签名链接为空")
	}
	return out.URL
}
