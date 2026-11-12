package protocol_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/leon82/pcp/cloud/internal/model"
	"github.com/leon82/pcp/cloud/internal/protocol"
)

// 契约：可选字段一律省略，**绝不出现 null**（跨语言 JSON 语义一致性）。
func TestEnvelopeOmitsEmptyFields(t *testing.T) {
	env := protocol.New(protocol.TypeBridgeOnline, 1000)
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "null") {
		t.Fatalf("信封不应包含 null: %s", raw)
	}
	for _, absent := range []string{"pairId", "taskId", "seq", "cmdId", "payload"} {
		if strings.Contains(string(raw), `"`+absent+`"`) {
			t.Fatalf("空字段 %q 应被省略: %s", absent, raw)
		}
	}
}

func TestEnvelopeValidate(t *testing.T) {
	cases := []struct {
		name    string
		env     protocol.Envelope
		wantErr bool
	}{
		{"正常 pair 级帧", protocol.New(protocol.TypeBridgeOnline, 1), false},
		{"版本不匹配", protocol.Envelope{V: 99, Type: protocol.TypePiEvent}, true},
		{"缺 type", protocol.Envelope{V: 1}, true},
		{"task 级帧缺 taskId", protocol.New(protocol.TypePiEvent, 1), true},
		{"task 级帧带 taskId", func() protocol.Envelope {
			e := protocol.New(protocol.TypePiEvent, 1)
			e.TaskID = "t_abcd1234"
			return e
		}(), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := c.env.Validate()
			if c.wantErr && err == nil {
				t.Fatal("期望报错但没有")
			}
			if !c.wantErr && err != nil {
				t.Fatalf("不期望报错: %v", err)
			}
		})
	}
}

func TestRefRoundTrip(t *testing.T) {
	id := model.NewID()
	ref := protocol.RefPair(id)
	if !strings.HasPrefix(ref, "p_") {
		t.Fatalf("前缀错误: %s", ref)
	}
	got, err := protocol.ParseRef(ref, "p")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if got != id {
		t.Fatalf("往返不一致: %s != %s", got, id)
	}

	// 短形式（8 位十六进制）也能解析，按 schema 允许 8..32
	short := "p_" + ref[2:18]
	if _, err := protocol.ParseRef(short, "p"); err != nil {
		t.Fatalf("短标识应可解析: %v", err)
	}

	if _, err := protocol.ParseRef("t_deadbeef", "p"); err == nil {
		t.Fatal("前缀不符应报错")
	}
	if _, err := protocol.ParseRef("p_xyz", "p"); err == nil {
		t.Fatal("非法十六进制应报错")
	}
}

func TestWithPayloadAndDecode(t *testing.T) {
	cap := protocol.Capacity{Running: 2, MaxRunning: 2, LiveChildren: 3, MaxLiveChildren: 4}
	env, err := protocol.New(protocol.TypeBridgeCapacity, 1).WithPayload(cap)
	if err != nil {
		t.Fatal(err)
	}
	var back protocol.Capacity
	if err := env.Decode(&back); err != nil {
		t.Fatal(err)
	}
	if back != cap {
		t.Fatalf("往返不一致: %+v != %+v", back, cap)
	}
}
