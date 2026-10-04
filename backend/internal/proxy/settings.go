package proxy

import (
	"os"
	"strings"
)

// Keys in the settings table and the environment override.
const (
	SettingManaged   = "proxy_managed" // "true" | "false" | "" (unset = default on)
	SettingACMEEmail = "acme_email"
	EnvManaged       = "PULSENODE_MANAGED_PROXY"
)

// Enabled reports whether PulseNode may start its own proxy when no Traefik is
// found. It defaults to on; either PULSENODE_MANAGED_PROXY=false or a saved
// proxy_managed=false (the Disable button) turns it off.
func Enabled(settingValue string) bool {
	if strings.EqualFold(strings.TrimSpace(os.Getenv(EnvManaged)), "false") {
		return false
	}
	return !strings.EqualFold(strings.TrimSpace(settingValue), "false")
}
