// SPDX-License-Identifier: AGPL-3.0-only

package auth

import "golang.org/x/text/unicode/norm"

// normalizeNFKC 对口令做 Unicode NFKC 归一化。
//
// 为什么需要:同一视觉相同的密码,若用户用全角输入法敲出"ＡＢＣ"
// 而另一次用半角敲出"ABC",不做归一化就会是两组完全不同的哈希。
// 用户会觉得"密码明明没错却登不上",且无从排查。
//
// 与 Node 版保持一致:那里用的是 string.normalize('NFKC')。
func normalizeNFKC(s string) string {
	return norm.NFKC.String(s)
}
