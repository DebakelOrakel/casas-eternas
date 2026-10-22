package cmd

import (
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/DebakelOrakel/casas-eternas/internal/modules/jobs"
)

const (
	flagCacheDir = "cache-dir"
	flagHeapMB   = "heap-mb"
)

// WorkerCmd runs one job worker through its launcher
// (internal/modules/jobs/launcher.go, docs/decisions/engine-releases.md).
var WorkerCmd = &cobra.Command{
	Use:   "worker <serving JSON>",
	Short: "Runs a job worker of the pipeline that has the work.",
	Long: `Runs a job worker: node on job-worker.mjs --serve, with the serving JSON
passed on unchanged ({"relay": "…", "pools": ["level", "tile"], "jobs": "…/v1"}).

The worker is of the pipeline that has the work. While this installation's own
pipeline (jobs.worker's bundle) has work, or nobody has any, it is that one.
Else the pipeline with the most work: its bundle and its engine for this
platform come from the server (GET /v1/jobs/engines, by "jobs"), into the
cache directory. A worker whose pipeline has no more work while another one has
ends with code 75, and the launcher chooses again. Any other end of the worker
ends this command with the worker's code.

The local job workers of 'start' run through this command; so do the cluster's
worker pods, and a worker on another machine.`,
	Args: cobra.ExactArgs(1),
	RunE: runWorkerCmd,
}

func init() {
	WorkerCmd.Flags().String(flagCacheDir, "", "The directory the bundles and engines of other pipelines are kept in, one directory per pipeline. Empty: pipelines/ beside the binary.")
	WorkerCmd.Flags().Int(flagHeapMB, jobs.NodeHeapMB, "The Node heap ceiling of the worker, MB.")
	RootCmd.AddCommand(WorkerCmd)
}

func runWorkerCmd(cmd *cobra.Command, args []string) error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	cacheDir, _ := cmd.Flags().GetString(flagCacheDir)
	if cacheDir == "" {
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		cacheDir = filepath.Join(filepath.Dir(executable), "pipelines")
	}
	heapMB, _ := cmd.Flags().GetInt(flagHeapMB)
	ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	code, err := jobs.RunLauncher(ctx, jobs.LauncherConfig{
		Bundle:   workerPath(cfg.Jobs.Worker),
		CacheDir: cacheDir,
		HeapMB:   heapMB,
		Serve:    args[0],
	})
	if err != nil {
		return fmt.Errorf("worker: %w", err)
	}
	if code != 0 {
		os.Exit(code)
	}
	return nil
}
