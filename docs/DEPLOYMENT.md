# 部署结构

本文只描述架构与配置方式，**不含任何主机地址、账号或密钥**。
具体的服务器运维细节保存在本地 `docs-local/`（已被 `.gitignore` 排除）。

## 拓扑

```
公网 443 ──► nginx（TLS 终止 / 路径分流 / 静态资源 / gzip）
               ├── /ws/    → 127.0.0.1:8787   bridge 长链（WSS）
               ├── /sse    → 127.0.0.1:8787   手机下行（SSE）
               ├── /api/ /pair/ /blob/ → 127.0.0.1:8787
               └── /       → 静态站点
```

**为什么保留 nginx**（而不是让 Go 直接占 443）：

| 原因 | 说明 |
|---|---|
| 443 需要共享 | 同一域名下还有静态站点与历史页面 |
| 证书集中管理 | acme.sh 装证书到固定路径，nginx 负责 TLS1.3 / HTTP2 |
| Go 保持简单 | 只说 HTTP/1.1、不写 TLS 代码、不做证书热加载 |

## Go 服务的硬性约束

1. **只 bind `127.0.0.1`**，不能 `0.0.0.0` —— 否则绕过 nginx 直接暴露明文 HTTP
2. **信任 `X-Forwarded-For`**（限速按真实客户端 IP 计）
3. **不设 `WriteTimeout`** —— SSE/WSS 是长连接

## nginx 三处不能改错

```nginx
location /ws/ {
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}

location = /sse {
    proxy_buffering off;      # 必须：否则事件被攒住，任务结束才一次性刷出
    proxy_cache off;
    gzip off;
    add_header X-Accel-Buffering no always;
    proxy_read_timeout 3600s;
}

# 其余上行端点共用一段 include，同样 proxy_buffering off
```

心跳按 30s 设计（链路实测空闲 130s 不断，留足余量）。

## 证书续期

用 acme.sh（webroot 模式，走 nginx 的 `/.well-known/acme-challenge/`），
自带 cron 每日检查，按 ARI 窗口在到期前自动续期，续期后 `systemctl reload nginx`。

**不要**用那种「临时把 vhost 换成 http-only → 跑 ACME → 还原」的脚本：
一旦签发失败就 `exit`、不还原配置，站点会永久丢掉 443 段。这类脚本的备份还常常
把「已经降级的配置」备份成 `.bak`，形成自我延续的降级。

## 数据库

- 独立库与**独立最小权限账号**（只授该库），不复用业务账号
- 凭据放 `/etc/pcp/mysql.env`，`chmod 600`，由 systemd `EnvironmentFile=` 注入
- DDL 由 `pcpd migrate` 应用（幂等），迁移文件随二进制 embedding
- 「一台 device 最多一个 active pair」由 MySQL 生成列 + 唯一索引兜底，不靠应用层自觉

## 常驻

```ini
# /etc/systemd/system/pcpd.service（要点）
[Service]
ExecStart=/opt/pcp/pcpd serve --store mysql
EnvironmentFile=/etc/pcp/mysql.env
User=pcp
Restart=always
```

单二进制部署，无运行时依赖；交叉编译：

```bash
GOOS=linux GOARCH=amd64 go build -o pcpd ./cmd/pcpd
```
