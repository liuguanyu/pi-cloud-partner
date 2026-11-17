package httpapi

import "testing"

// 白名单语义：允许根目录本身与其子目录，拒绝外部与"前缀相似的兄弟目录"。
// 这条规则必须与 bridge 侧（runner.ts#workspaceAllowed）一致，否则会出现
// "手机端能选、提交却被拒"这种割裂。
func TestWorkspaceAllowlistSemantics(t *testing.T) {
	allowed := []string{"/Users/me/devspace"}

	cases := []struct {
		path string
		want bool
	}{
		{"/Users/me/devspace", true},
		{"/Users/me/devspace/", true},
		{"/Users/me/devspace/abop-bootstrap", true},
		{"/Users/me/devspace/a/b/c", true},
		// 前缀相似但不是子目录 → 必须拒绝
		{"/Users/me/devspace-evil", false},
		{"/Users/me", false},
		{"/etc", false},
	}

	for _, c := range cases {
		if got := containsPath(allowed, c.path); got != c.want {
			t.Errorf("containsPath(%q) = %v, 期望 %v", c.path, got, c.want)
		}
	}
}
