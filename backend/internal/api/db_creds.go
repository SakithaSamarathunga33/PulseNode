package api

import "strings"

// Database passwords must not appear on a command line: with pid: host on go-api
// and the DB container, every process on the host can read /proc/<pid>/cmdline.
// These helpers hand them over through the exec's environment (or, for the
// MongoDB tools, which read no password variable, a 0600 temp file) instead.

// mysqlAuthEnv is the environment for mysql/mysqldump (they read MYSQL_PWD).
func mysqlAuthEnv(password string) []string {
	if password == "" {
		return nil
	}
	return []string{"MYSQL_PWD=" + password}
}

// redisAuthEnv is the environment for redis-cli (it reads REDISCLI_AUTH).
func redisAuthEnv(password string) []string {
	if password == "" {
		return nil
	}
	return []string{"REDISCLI_AUTH=" + password}
}

// mongoToolCmd returns the command and env to run a MongoDB tool (mongodump,
// mongorestore) as user. The tools have no password variable, so the password is
// written by a tiny sh wrapper into a 0600 config file that is removed afterwards;
// tool and args are positional parameters, so nothing is interpreted by the shell.
func mongoToolCmd(tool string, args []string, user, password string) (cmd, env []string) {
	if user == "" {
		return append([]string{tool}, args...), nil
	}
	const script = `umask 077; f=$(mktemp) || exit 1; ` +
		`printf 'password: %s\n' "$PN_MONGO_PWD" > "$f"; ` +
		`"$@" --config "$f"; rc=$?; rm -f "$f"; exit $rc`
	cmd = append([]string{"sh", "-c", script, "sh", tool}, args...)
	cmd = append(cmd, "--username", user, "--authenticationDatabase", "admin")
	return cmd, []string{"PN_MONGO_PWD=" + yamlSingleQuote(password)}
}

// yamlSingleQuote renders s as a YAML single-quoted scalar.
func yamlSingleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}
