// Package auth 负责凭据的生成与校验。
//
// 设计：所有 token 都是 32 字节随机数的 base64url 编码，DB 只存 sha256 十六进制。
// 不做 bcrypt —— 这些是高熵随机串，不是用户口令，sha256 足够且能走索引等值查询。
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
)

const tokenBytes = 32

// NewToken 生成新凭据，返回 (明文, 哈希)。明文只在签发那一刻出现一次。
func NewToken() (plain, hash string) {
	buf := make([]byte, tokenBytes)
	if _, err := rand.Read(buf); err != nil {
		panic("cloud: entropy source unavailable: " + err.Error())
	}
	plain = base64.RawURLEncoding.EncodeToString(buf)
	return plain, Hash(plain)
}

// Hash 计算凭据的存储形式。
func Hash(plain string) string {
	sum := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(sum[:])
}

// BearerToken 从 `Authorization: Bearer <t>` 中取出 t。
func BearerToken(header string) (string, bool) {
	const prefix = "Bearer "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return "", false
	}
	token := strings.TrimSpace(header[len(prefix):])
	return token, token != ""
}

// DeviceToken 从 `Authorization: Device <t>` 中取出 t。
func DeviceToken(header string) (string, bool) {
	const prefix = "Device "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return "", false
	}
	token := strings.TrimSpace(header[len(prefix):])
	return token, token != ""
}
