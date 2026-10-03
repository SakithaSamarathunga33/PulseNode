package builder

import (
	"os"
	"path/filepath"
)

type Method string

const (
	MethodCompose    Method = "compose"
	MethodDockerfile Method = "dockerfile"
	MethodNixpacks   Method = "nixpacks"
)

// Detect returns the build method for a cloned repo directory.
// Priority: docker-compose.yml > Dockerfile > nixpacks
func Detect(dir string) Method {
	if composeFileName(dir) != "" {
		return MethodCompose
	}
	if fileExists(dir + "/Dockerfile") {
		return MethodDockerfile
	}
	return MethodNixpacks
}

// composeFileName is the compose file a repo ships ("" if none). Policy check,
// `config` and `up` all use this one name, so what is validated is what runs.
func composeFileName(dir string) string {
	for _, name := range []string{"docker-compose.yml", "docker-compose.yaml"} {
		// A committed symlink to a file outside the clone would make compose read
		// (and its parse errors echo) a panel file; treat it as no compose file.
		if fileExists(dir+"/"+name) && resolvedWithin(dir, filepath.Join(dir, name)) {
			return name
		}
	}
	return ""
}

// DetectMonorepo reports a frontend/ + backend/ split: true only when BOTH a
// frontend/ and backend/ directory exist at the repo root and each is
// independently buildable. The returned paths are absolute (under root).
func DetectMonorepo(root string) (frontendDir, backendDir string, ok bool) {
	fe := filepath.Join(root, "frontend")
	be := filepath.Join(root, "backend")
	// frontend/ or backend/ committed as a symlink to a host path (e.g. /workspace)
	// would otherwise become the Docker build context.
	if !resolvedWithin(root, fe) || !resolvedWithin(root, be) {
		return "", "", false
	}
	if buildableDir(fe) && buildableDir(be) {
		return fe, be, true
	}
	return "", "", false
}

// buildableProjectFiles are the markers that mean a directory can be built on
// its own (Dockerfile, or a recognised package manifest for the languages
// nixpacks supports).
var buildableProjectFiles = []string{
	"Dockerfile",
	"package.json", // node
	"go.mod",       // go
	"requirements.txt", "pyproject.toml", "Pipfile", // python
	"Gemfile",     // ruby
	"Cargo.toml",  // rust
	"composer.json", // php
}

// buildableDir reports whether dir is a directory containing at least one
// recognised build marker.
func buildableDir(dir string) bool {
	fi, err := os.Lstat(dir)
	if err == nil && fi.Mode()&os.ModeSymlink != 0 {
		return false // symlinked build dirs are never followed
	}
	if err != nil || !fi.IsDir() {
		return false
	}
	for _, f := range buildableProjectFiles {
		if fileExists(filepath.Join(dir, f)) {
			return true
		}
	}
	return false
}

// IsBuildMarker reports whether a filename is a recognised build marker. It lets
// callers that list a directory by name (e.g. via the GitHub contents API)
// reuse the same buildability rule as buildableDir without a working tree.
func IsBuildMarker(name string) bool {
	for _, f := range buildableProjectFiles {
		if name == f {
			return true
		}
	}
	return false
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
