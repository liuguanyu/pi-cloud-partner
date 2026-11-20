package httpapi_test

import (
	"net/http"
	"testing"
)

// 同一台手机（浏览器环境指纹一致）重新配对时免人工批准。
// 覆盖三个分支：同指纹→自动 active；异指纹→保持 pending；无历史→保持 pending。
func TestRepeatClientAutoApproveByFingerprint(t *testing.T) {
	e := newEnv(t)
	fp := "fp-iphone-15-same-env"

	// ── 第一次配对（正常人工批准）──
	var pr pairRequestResp
	e.do("POST", "/pair/request", "Device "+e.devTok, map[string]any{}, &pr)
	var claim1 claimResp
	resp := e.do("POST", "/pair/claim", "", map[string]any{
		"code": pr.Code, "deviceName": "iPhone", "claimantId": "c1", "fingerprint": fp,
	}, &claim1)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("首次 claim 应成功，实际 %d", resp.StatusCode)
	}
	if claim1.Status != "pending_approval" {
		t.Fatalf("首次配对（无历史）必须保持 pending，实际 %s", claim1.Status)
	}
	e.do("POST", "/pair/approve", "Device "+e.devTok, map[string]any{"pairId": claim1.PairID, "decision": "approve"}, nil)

	// ── 第一次配对失效（模拟凭据被 iOS 清掉后重连）──
	e.do("POST", "/pair/revoke", "Device "+e.devTok, map[string]any{"pairId": claim1.PairID, "reason": "test"}, nil)

	// ── 第二次配对：同指纹 → 自动批准，无需 PC ──
	var pr2 pairRequestResp
	e.do("POST", "/pair/request", "Device "+e.devTok, map[string]any{}, &pr2)
	var claim2 claimResp
	resp = e.do("POST", "/pair/claim", "", map[string]any{
		"code": pr2.Code, "deviceName": "iPhone", "claimantId": "c2", "fingerprint": fp,
	}, &claim2)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("重配对 claim 应成功，实际 %d", resp.StatusCode)
	}
	if claim2.Status != "active" {
		t.Fatalf("同指纹重配对应自动批准为 active，实际 %s", claim2.Status)
	}

	// ── 第三次配对：不同指纹 → 保持 pending（必须人工批准）──
	e.do("POST", "/pair/revoke", "Device "+e.devTok, map[string]any{"pairId": claim2.PairID, "reason": "test"}, nil)
	var pr3 pairRequestResp
	e.do("POST", "/pair/request", "Device "+e.devTok, map[string]any{}, &pr3)
	var claim3 claimResp
	resp = e.do("POST", "/pair/claim", "", map[string]any{
		"code": pr3.Code, "deviceName": "另一台手机", "claimantId": "c3", "fingerprint": "fp-other-device",
	}, &claim3)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("异指纹 claim 应成功，实际 %d", resp.StatusCode)
	}
	if claim3.Status != "pending_approval" {
		t.Fatalf("异指纹必须保持 pending（人工批准），实际 %s", claim3.Status)
	}

	// 未批准时不能换 token
	var sess map[string]any
	resp = e.do("POST", "/api/session", "Bearer "+claim3.RefreshToken, map[string]any{"pairId": claim3.PairID}, &sess)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("未批准 pair 换 token 应 403，实际 %d", resp.StatusCode)
	}

	// ── 第四次：不带指纹 → 保持 pending ──
	e.do("POST", "/pair/revoke", "Device "+e.devTok, map[string]any{"pairId": claim3.PairID, "reason": "test"}, nil)
	var pr4 pairRequestResp
	e.do("POST", "/pair/request", "Device "+e.devTok, map[string]any{}, &pr4)
	var claim4 claimResp
	e.do("POST", "/pair/claim", "", map[string]any{
		"code": pr4.Code, "deviceName": "老版客户端", "claimantId": "c4",
	}, &claim4)
	if claim4.Status != "pending_approval" {
		t.Fatalf("不带指纹必须保持 pending，实际 %s", claim4.Status)
	}
}
