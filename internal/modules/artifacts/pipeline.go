package artifacts

import (
	"bytes"
	"context"
	"encoding/json"
	"time"
)

// The pipeline builds' two operations for the jobs module
// (docs/decisions/engine-releases.md; PipelineWorld for their rules). In
// this process only: cmd/ composes them into the jobs module's
// PipelineFiles, and no HTTP route writes them.

// PipelineFileLink answers a link that reads one file of a pipeline's
// release, as a read of the artifact does (handleGet), or ErrNotFound when
// the store does not hold it whole.
func (m *Module) PipelineFileLink(ctx context.Context, pipeline, file string) (string, error) {
	key := Key{WorldID: PipelineWorld, PipelineVersion: pipeline, Stage: file}
	whole, err := m.store.Whole(ctx, []Key{key})
	if err != nil {
		return "", err
	}
	if !whole[0] {
		return "", ErrNotFound
	}
	uid, _, err := m.store.Resolve(ctx, key, false)
	if err != nil {
		return "", err
	}
	link, err := m.store.Link(ctx, uid, file, m.readTTL)
	if err != nil {
		return "", err
	}
	return link.URL, nil
}

// PutPipelineFile stores one file of a pipeline's release: the file, then
// its meta.json, which makes it whole, as every writer does.
func (m *Module) PutPipelineFile(ctx context.Context, pipeline, file string, body []byte) error {
	key := Key{WorldID: PipelineWorld, PipelineVersion: pipeline, Stage: file}
	uid, _, err := m.store.Resolve(ctx, key, true)
	if err != nil {
		return err
	}
	if err := m.store.Write(ctx, uid, file, bytes.NewReader(body), int64(len(body))); err != nil {
		return err
	}
	meta, err := json.Marshal(entryMeta{Key: key, Label: "generator-" + pipeline + " " + file, CreatedAt: time.Now().UnixMilli()})
	if err != nil {
		return err
	}
	return m.store.Write(ctx, uid, metaName, bytes.NewReader(meta), int64(len(meta)))
}
