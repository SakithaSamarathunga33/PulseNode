package backups

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	kdfLogN = 10 // fast tests; TestProductionKDFCost pins the real value
	os.Exit(m.Run())
}
