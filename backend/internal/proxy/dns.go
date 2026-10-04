package proxy

import "strings"

// multiPartSuffixes are common public suffixes with more than one label, so that
// "app.example.co.uk" has the root "example.co.uk" and not "co.uk". It is a small
// built-in list, not the full Public Suffix List.
var multiPartSuffixes = map[string]bool{
	"co.uk": true, "org.uk": true, "ac.uk": true, "gov.uk": true, "me.uk": true, "ltd.uk": true, "plc.uk": true, "net.uk": true, "sch.uk": true,
	"com.au": true, "net.au": true, "org.au": true, "edu.au": true, "gov.au": true, "id.au": true,
	"co.nz": true, "org.nz": true, "net.nz": true, "ac.nz": true, "govt.nz": true,
	"co.za": true, "org.za": true, "ac.za": true, "gov.za": true, "net.za": true,
	"co.in": true, "net.in": true, "org.in": true, "firm.in": true, "gen.in": true, "ind.in": true, "ac.in": true, "edu.in": true, "gov.in": true,
	"com.lk": true, "org.lk": true, "edu.lk": true, "gov.lk": true, "net.lk": true, "ac.lk": true,
	"co.jp": true, "ne.jp": true, "or.jp": true, "ac.jp": true, "go.jp": true,
	"com.br": true, "net.br": true, "org.br": true, "gov.br": true, "edu.br": true,
	"com.cn": true, "net.cn": true, "org.cn": true, "gov.cn": true, "edu.cn": true,
	"com.hk": true, "com.sg": true, "com.my": true, "com.mx": true, "com.ar": true, "com.tr": true, "com.tw": true, "com.ua": true,
	"co.kr": true, "or.kr": true, "co.id": true, "or.id": true, "com.ph": true, "com.vn": true, "co.th": true,
	"com.pk": true, "com.bd": true, "com.np": true, "co.il": true, "org.il": true, "com.eg": true, "com.ng": true, "co.ke": true,
	"com.co": true, "com.pe": true, "com.ve": true, "com.sa": true, "com.ec": true, "com.pl": true, "com.es": true,
}

// RegistrableRoot returns the registrable root of a hostname: the public suffix
// plus one label. An apex input is its own root; a bare suffix or a single label
// is returned unchanged.
func RegistrableRoot(host string) string {
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), ".")
	labels := strings.Split(host, ".")
	if len(labels) <= 2 {
		return host
	}
	keep := 2
	if multiPartSuffixes[strings.Join(labels[len(labels)-2:], ".")] {
		keep = 3
	}
	if len(labels) <= keep {
		return host
	}
	return strings.Join(labels[len(labels)-keep:], ".")
}
