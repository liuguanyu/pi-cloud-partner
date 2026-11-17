// 命令 pcpd 是 pi-cloud-partner 的云端服务（Go 单二进制）。
//
// 子命令：
//
//	pcpd serve                        启动 HTTP/SSE/WSS 服务
//	pcpd migrate                      应用 MySQL DDL
//	pcpd device create --name <n>     创建设备并打印 deviceToken（只打印一次）
//	pcpd user create --name <n>       创建用户并打印 userToken（M1 用它代替 SSO 登录）
//	pcpd version
//
// 设计取舍（SPEC.md D2/D4）：单二进制、无状态、只监听 127.0.0.1，TLS 与路径分流交给 nginx。
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/leon82/pcp/cloud/internal/auth"
	"github.com/leon82/pcp/cloud/internal/httpapi"
	"github.com/leon82/pcp/cloud/internal/hub"
	"github.com/leon82/pcp/cloud/internal/model"
	"github.com/leon82/pcp/cloud/internal/pairing"
	"github.com/leon82/pcp/cloud/internal/protocol"
	"github.com/leon82/pcp/cloud/internal/store"
	"github.com/leon82/pcp/cloud/internal/store/memory"
	"github.com/leon82/pcp/cloud/internal/store/mysql"
)

const version = "0.1.0"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = runServe(os.Args[2:])
	case "migrate":
		err = runMigrate(os.Args[2:])
	case "device":
		err = runCreate(os.Args[2:], "device")
	case "user":
		err = runCreate(os.Args[2:], "user")
	case "version", "-v", "--version":
		fmt.Printf("pcpd %s (protocol v%d)\n", version, protocol.Version)
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "未知子命令 %q\n", os.Args[1])
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "错误:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `pcpd — pi-cloud-partner 云端服务

用法:
  pcpd serve [选项]
      --addr 127.0.0.1:8787     监听地址（只能绑回环，TLS 交给 nginx）
      --store memory|mysql      存储后端，默认 memory
      --dsn <dsn>               MySQL DSN（也可用 PCP_MYSQL_DSN）
      --origins <a,b>           允许的 CORS 源，默认不限制
      --dev-bootstrap           仅在 memory 模式下：启动时创建演示 user/device 并打印凭据

  pcpd migrate --dsn <dsn>      应用 DDL

  pcpd device create --name <n> --dsn <dsn>    创建设备，打印 deviceToken
  pcpd user create --name <n> --dsn <dsn>      创建用户，打印 userToken

  pcpd version
`)
}

// ── serve ─────────────────────────────────────────────────────

type serveOpts struct {
	addr         string
	storeKind    string
	dsn          string
	origins      string
	devBootstrap bool
	codeTTL      time.Duration
}

func parseServeFlags(args []string) serveOpts {
	var o serveOpts
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	fs.StringVar(&o.addr, "addr", "127.0.0.1:8787", "监听地址")
	fs.StringVar(&o.storeKind, "store", "memory", "memory|mysql")
	fs.StringVar(&o.dsn, "dsn", os.Getenv("PCP_MYSQL_DSN"), "MySQL DSN")
	fs.StringVar(&o.origins, "origins", "", "允许的 CORS 源，逗号分隔")
	fs.BoolVar(&o.devBootstrap, "dev-bootstrap", false, "memory 模式下的演示凭据")
	fs.DurationVar(&o.codeTTL, "code-ttl", 120*time.Second, "配对码有效期")
	_ = fs.Parse(args)
	return o
}

func buildStore(ctx context.Context, kind, dsn string) (store.Store, error) {
	switch kind {
	case "memory":
		return memory.New(), nil
	case "mysql":
		if dsn == "" {
			return nil, errors.New("mysql 模式需要 --dsn 或 PCP_MYSQL_DSN")
		}
		st, err := mysql.Open(dsn)
		if err != nil {
			return nil, err
		}
		if err := st.Migrate(ctx); err != nil {
			return nil, fmt.Errorf("应用 DDL 失败: %w", err)
		}
		return st, nil
	default:
		return nil, fmt.Errorf("未知 store 类型 %q", kind)
	}
}

func runServe(args []string) error {
	o := parseServeFlags(args)
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	st, err := buildStore(ctx, o.storeKind, o.dsn)
	if err != nil {
		return err
	}
	defer st.Close()

	cfg := pairing.DefaultConfig()
	if o.codeTTL > 0 {
		cfg.CodeTTL = o.codeTTL
	}
	pairSvc := pairing.New(st, cfg)
	h := hub.New()

	if o.devBootstrap {
		if o.storeKind != "memory" {
			return errors.New("--dev-bootstrap 只允许用于 memory（避免在生产库留下演示数据）")
		}
		userTok, devTok, err := bootstrapDemo(ctx, st, logger)
		if err != nil {
			return err
		}
		fmt.Printf("\n  ── 演示凭据（memory 模式，进程退出即失效）──\n")
		fmt.Printf("  userToken   (手机 claim 用): %s\n", userTok)
		fmt.Printf("  deviceToken (bridge/PC 用) : %s\n\n", devTok)
	}

	// bridge 上下线时给已授权的手机推事件
	h.OnBridgeChange(func(deviceID model.ID, online bool, name string) {
		pairs, err := st.PairsByDevice(ctx, deviceID)
		if err != nil {
			return
		}
		frameType := protocol.TypeBridgeOffline
		if online {
			frameType = protocol.TypeBridgeOnline
		}
		for _, p := range pairs {
			if p.Status != model.PairActive && p.Status != model.PairSuspended {
				continue
			}
			env, err := protocol.New(frameType, time.Now().UnixMilli()).WithPayload(map[string]string{"deviceName": name})
			if err != nil {
				continue
			}
			h.Publish(p.ID, env, protocol.Marshal)
		}
	})

	var origins []string
	if o.origins != "" {
		for _, part := range strings.Split(o.origins, ",") {
			if trimmed := strings.TrimSpace(part); trimmed != "" {
				origins = append(origins, trimmed)
			}
		}
	}

	// 空闲 pair 回收：每 5 分钟扫一次，30 分钟无人订阅且无事件就释放 ring
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if removed := h.Sweep(int64(30*time.Minute/time.Millisecond), time.Now().UnixMilli()); removed > 0 {
					logger.Info("回收空闲 pair 状态", "count", removed)
				}
			}
		}
	}()

	srv := httpapi.New(httpapi.Config{
		Store:          st,
		Pairing:        pairSvc,
		Hub:            h,
		Log:            logger,
		AllowedOrigins: origins,
	})

	httpServer := &http.Server{
		Addr:              o.addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// SSE / WSS 是长连接，绝不能设 WriteTimeout
		WriteTimeout: 0,
		IdleTimeout:  0,
	}

	go func() {
		logger.Info("pcpd listening", "addr", o.addr, "store", o.storeKind, "protocol", protocol.Version)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server error", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	logger.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return httpServer.Shutdown(shutdownCtx)
}

// bootstrapDemo 为本地联调创建一组固定身份，凭据只在启动日志里出现。
func bootstrapDemo(ctx context.Context, st store.Store, logger *slog.Logger) (userToken, deviceToken string, err error) {
	now := time.Now().UnixMilli()

	user, err := st.UpsertUser(ctx, "demo@local", "demo", now)
	if err != nil {
		return "", "", err
	}
	dev, err := createDeviceWithToken(ctx, st, "dev-demo", now)
	if err != nil {
		return "", "", err
	}
	logger.Info("demo identity ready", "userId", user.ID.String(), "deviceId", dev.ID.String())

	tokens, err := issueTokens(ctx, st, now, user.ID, model.TokenUser)
	if err != nil {
		return "", "", err
	}
	devTokens, err := issueTokens(ctx, st, now, dev.ID, model.TokenDevice)
	if err != nil {
		return "", "", err
	}
	return tokens, devTokens, nil
}

func runMigrate(args []string) error {
	fs := flag.NewFlagSet("migrate", flag.ExitOnError)
	dsn := fs.String("dsn", os.Getenv("PCP_MYSQL_DSN"), "MySQL DSN")
	_ = fs.Parse(args)
	if *dsn == "" {
		return errors.New("需要 --dsn 或 PCP_MYSQL_DSN")
	}
	st, err := mysql.Open(*dsn)
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.Migrate(context.Background()); err != nil {
		return err
	}
	fmt.Println("DDL 已应用")
	return nil
}

// runCreate 创建 device 或 user，并打印一次凭据。
func runCreate(args []string, kind string) error {
	sub := ""
	if len(args) > 0 && (args[0] == "create" || args[0] == "new") {
		sub = "create"
		args = args[1:]
	}
	if sub == "" {
		return fmt.Errorf("用法: pcpd %s create --name <名称> --dsn <dsn>", kind)
	}

	fs := flag.NewFlagSet(kind+" create", flag.ExitOnError)
	name := fs.String("name", "", "名称")
	dsn := fs.String("dsn", os.Getenv("PCP_MYSQL_DSN"), "MySQL DSN")
	_ = fs.Parse(args)
	if *name == "" || *dsn == "" {
		return fmt.Errorf("需要 --name 与 --dsn")
	}

	ctx := context.Background()
	st, err := mysql.Open(*dsn)
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		return err
	}
	now := time.Now().UnixMilli()

	switch kind {
	case "device":
		dev, err := createDeviceWithToken(ctx, st, *name, now)
		if err != nil {
			return err
		}
		token, err := issueTokens(ctx, st, now, dev.ID, model.TokenDevice)
		if err != nil {
			return err
		}
		fmt.Printf("deviceId: %s\n", dev.ID.String())
		fmt.Printf("deviceToken: %s\n", token)
		fmt.Println("（凭据只显示这一次，请写入 ~/.pi/bridge/credentials.json 并 chmod 600）")
	case "user":
		user, err := st.UpsertUser(ctx, *name, *name, now)
		if err != nil {
			return err
		}
		token, err := issueTokens(ctx, st, now, user.ID, model.TokenUser)
		if err != nil {
			return err
		}
		fmt.Printf("userId: %s\n", user.ID.String())
		fmt.Printf("userToken: %s\n", token)
		fmt.Println("（M1 用长期 token 代替 SSO 登录，仅用于 /pair/claim）")
	}
	return nil
}

func createDeviceWithToken(ctx context.Context, st store.Store, name string, now int64) (model.Device, error) {
	// fingerprint 用于防止重复注册同一台机器：M1 用名字派生，后续可由 bridge 上报
	fingerprint := auth.Hash("pcp-device:" + name)
	dev := model.Device{
		ID:          model.NewID(),
		Name:        name,
		Fingerprint: fingerprint,
		CreatedAt:   now,
	}
	if err := st.CreateDevice(ctx, dev); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return model.Device{}, fmt.Errorf("设备指纹已存在（名字 %q 已注册）", name)
		}
		return model.Device{}, err
	}
	return dev, nil
}

func issueTokens(ctx context.Context, st store.Store, now int64, subject model.ID, kind model.TokenKind) (string, error) {
	plain, hash := auth.NewToken()
	var expires *int64
	if kind == model.TokenPair {
		ts := now + int64(12*time.Hour/time.Millisecond)
		expires = &ts
	}
	return plain, st.CreateToken(ctx, model.Token{
		ID:        model.NewID(),
		Kind:      kind,
		SubjectID: subject,
		Hash:      hash,
		CreatedAt: now,
		ExpiresAt: expires,
	})
}
