package world

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
)

// How much of a save the server understands, and no more.
//
// Exactly two things are read out of an uploaded .zip: world.yaml (its
// `metadata` block and a few display values), and preview.png. Everything
// else stays opaque bytes. And exactly one thing is ever WRITTEN into one:
// a copy's new identity in the `metadata` block (copySave, 2026-10-15). That is a deliberate constraint rather than
// laziness — it is what lets the save format keep evolving (new rasters, new
// spec groups, a reshuffled snapshot) without the server needing a matching
// release. See docs/decisions/server-storage.md.

// previewLimit caps the extracted thumbnail. A preview is a small PNG of the
// map; anything far larger is not one, and decompressing it into memory on an
// upload path is how a zip bomb gets in.
const previewLimit = 8 << 20 // 8 MiB

// yamlLine matches "  key: value", the only shape a recipe writes. A key may
// hold a "/" — an annotation key is prefixed, `casas-eternas/copied-from` —
// and a ".", as a prefix that is a domain does (`example.com/x`). A "." is
// also the path separator of readYAMLValue, so a path cannot name such a
// key; the server reads no annotation. The same keys as the client's reader
// (client/src/world/save/recipeYaml.ts).
var yamlLine = regexp.MustCompile(`^(\s*)([\w./-]+):\s*(.*)$`)

// CopiedFromAnnotation names the world a copy was made from, by its uid:
// `metadata.annotations` in world.yaml, Kubernetes style. The prefix is the
// one the save's own apiVersion carries (casas-eternas/v1alpha1). Written by
// copySave here and by the client's browser copy (client/src/world/
// worldCopy.ts) — the same key in both, documentation only: nothing ranks or
// keys by it. See docs/decisions/template-worlds.md.
const CopiedFromAnnotation = "casas-eternas/copied-from"

// readYAMLValue reads one dotted path out of world.yaml.
//
// A deliberate mirror of the client's world/save/recipeYaml.ts, down to the
// indentation tracking, rather than a YAML dependency: the file is written by
// our own client in a known shape, and the two readers agreeing matters more
// than generality. Matching the LEAF name anywhere would be the tempting
// shortcut and is the bug the client already had — `seed:` is indented under
// `spec:`, so a leaf match silently returned the wrong group's value.
func readYAMLValue(text, path string) (string, bool) {
	type frame struct {
		indent int
		key    string
	}
	var stack []frame
	for _, line := range strings.Split(text, "\n") {
		match := yamlLine.FindStringSubmatch(strings.TrimRight(line, "\r"))
		if match == nil {
			continue
		}
		indent := len(match[1])
		for len(stack) > 0 && stack[len(stack)-1].indent >= indent {
			stack = stack[:len(stack)-1]
		}
		stack = append(stack, frame{indent: indent, key: match[2]})
		value := match[3]
		if value == "" {
			continue
		}
		keys := make([]string, len(stack))
		for i, f := range stack {
			keys[i] = f.key
		}
		if strings.Join(keys, ".") == path {
			return strings.Trim(value, `"'`), true
		}
	}
	return "", false
}

// SaveInfo is everything the server takes from an uploaded world.
type SaveInfo struct {
	UID  string
	Name string
	// Revision as the CLIENT recorded it. The store does not trust this for
	// ordering — it assigns its own — but it is worth carrying so a mismatch
	// between what a client thinks it wrote and what the store holds is
	// visible rather than silently reconciled.
	Revision   int
	ErosionRun int
	// Display data for listings, read from the same yaml the fields above
	// come from: the recipe's seed and the build that wrote the save
	// (status.generator — provenance, never a key). Empty for saves that
	// predate them.
	Seed      string
	Generator string
	// The pipeline that made the world (status.pipeline, the client's
	// world/worldPipeline.ts): display data like the rest. Empty for a save
	// that predates it or whose runs no single pipeline made.
	Pipeline string
	// The save's terrain id (status.terrain, the client's
	// identity.deriveWorldId over the save's bytes): display data, said by
	// the client and not checked — the rights on a terrain are Meta.Terrains,
	// which jobs report. Empty for a save that predates it.
	Terrain string
	// The world's shape (the top-level `kind`: FlatWorld or SphereWorld) and
	// the last step its user accepted (status.progress, a step id). Both are
	// display data, as above: the server does not check them. Empty for saves
	// that predate them.
	Kind     string
	Progress string
	Preview  []byte
}

// inspectSave reads the two things above out of a .zip.
//
// A save with no `metadata.uid` is rejected rather than assigned one: the
// client mints or derives it (client/src/world/identity.ts), and having the server
// invent one too would mean the same world could enter the store twice under
// two ids, which is the exact failure the uid exists to prevent.
func inspectSave(data []byte) (SaveInfo, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return SaveInfo{}, fmt.Errorf("not a readable zip: %w", err)
	}

	var info SaveInfo
	var yamlText string
	for _, file := range reader.File {
		switch file.Name {
		case "world.yaml":
			yamlText, err = readEntry(file, 1<<20)
			if err != nil {
				return SaveInfo{}, fmt.Errorf("reading world.yaml: %w", err)
			}
		case "preview.png":
			raw, readErr := readEntryBytes(file, previewLimit)
			if readErr != nil {
				// A save is still perfectly valid without a usable preview;
				// the listing just shows no thumbnail for it.
				continue
			}
			info.Preview = raw
		}
	}
	if yamlText == "" {
		return SaveInfo{}, fmt.Errorf("no world.yaml in the archive")
	}

	uid, ok := readYAMLValue(yamlText, "metadata.uid")
	if !ok || uid == "" {
		return SaveInfo{}, fmt.Errorf("world.yaml carries no metadata.uid")
	}
	info.UID = uid
	info.Name, _ = readYAMLValue(yamlText, "metadata.name")
	if raw, found := readYAMLValue(yamlText, "status.revision"); found {
		info.Revision, _ = strconv.Atoi(raw)
	}
	if raw, found := readYAMLValue(yamlText, "status.erosionRun"); found {
		info.ErosionRun, _ = strconv.Atoi(raw)
	}
	info.Seed, _ = readYAMLValue(yamlText, "spec.seed")
	info.Generator, _ = readYAMLValue(yamlText, "status.generator")
	info.Pipeline, _ = readYAMLValue(yamlText, "status.pipeline")
	info.Terrain, _ = readYAMLValue(yamlText, "status.terrain")
	info.Kind, _ = readYAMLValue(yamlText, "kind")
	info.Progress, _ = readYAMLValue(yamlText, "status.progress")
	return info, nil
}

func readEntry(file *zip.File, limit int64) (string, error) {
	raw, err := readEntryBytes(file, limit)
	return string(raw), err
}

// readEntryBytes decompresses one entry under a hard ceiling. The declared
// UncompressedSize64 is NOT trusted — it is attacker-controlled in a hostile
// archive — so the limit is enforced on the actual read.
func readEntryBytes(file *zip.File, limit int64) ([]byte, error) {
	rc, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer func() { _ = rc.Close() }()
	raw, err := io.ReadAll(io.LimitReader(rc, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, fmt.Errorf("%s exceeds %d bytes", file.Name, limit)
	}
	return raw, nil
}

// copySave is a save under a new identity: world.yaml's `metadata.uid` set to
// newUID and the annotation CopiedFromAnnotation set to sourceUID; every other
// entry of the archive is copied as it is, compressed bytes included. The
// terrain is therefore the same terrain, and the client derives the same
// terrain id (worldId) from it.
//
// The edit is a text edit of the metadata block, in the shape the client
// writes (recordToYaml): `metadata:` at the top level, its keys indented by
// two spaces, annotations deeper (withCopyIdentity). The rest of world.yaml
// is not read.
func copySave(data []byte, newUID, sourceUID string) ([]byte, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("not a readable zip: %w", err)
	}
	var out bytes.Buffer
	writer := zip.NewWriter(&out)
	seen := false
	for _, file := range reader.File {
		if file.Name != "world.yaml" {
			if err := writer.Copy(file); err != nil {
				return nil, fmt.Errorf("copying %s: %w", file.Name, err)
			}
			continue
		}
		text, err := readEntry(file, 1<<20)
		if err != nil {
			return nil, fmt.Errorf("reading world.yaml: %w", err)
		}
		rewritten, err := withCopyIdentity(text, newUID, sourceUID)
		if err != nil {
			return nil, err
		}
		header := file.FileHeader
		entry, err := writer.CreateHeader(&header)
		if err != nil {
			return nil, err
		}
		if _, err := io.WriteString(entry, rewritten); err != nil {
			return nil, err
		}
		seen = true
	}
	if !seen {
		return nil, fmt.Errorf("no world.yaml in the archive")
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// metadataKey and annotationKey find the key of a metadata line (two
// spaces) and of an annotation line (any indent). A key may hold a "." and
// a "/" (`example.com/x`).
var (
	metadataKey   = regexp.MustCompile(`^ {2}([\w./-]+):`)
	annotationKey = regexp.MustCompile(`^ *([\w./-]+):`)
)

// withCopyIdentity edits world.yaml's metadata block: the uid replaced, the
// copied-from annotation set (any other annotation kept, in its order).
// A copy of a copy names its direct source.
//
// THE ANNOTATIONS BLOCK is every line under `  annotations:` that is
// indented deeper than it, up to the next line that is not. Its lines are
// kept as they are (keys may hold a "." and a "/", values their quotes);
// only the copied-from entry and the lines deeper than it are dropped, and
// the new copied-from entry is written last with the indent of the block's
// first entry (four spaces when there is none). The lines of the block end
// as the `metadata:` line does (CRLF stays CRLF). Until 2026-10-16 a key
// with a "." ended the block, and the lines after it were copied out of it
// (invalid YAML).
//
// The mirror of the browser's rewrite (client/src/world/worldCopy.ts):
// both pass the cases of testdata/copy-identity.json.
func withCopyIdentity(text, newUID, sourceUID string) (string, error) {
	lines := strings.Split(text, "\n")
	start := -1
	for i, line := range lines {
		if strings.TrimRight(line, "\r") == "metadata:" {
			start = i
			break
		}
	}
	if start < 0 {
		return "", fmt.Errorf("world.yaml carries no metadata block")
	}
	eol := ""
	if strings.HasSuffix(lines[start], "\r") {
		eol = "\r"
	}
	end := len(lines)
	for i := start + 1; i < len(lines); i++ {
		line := strings.TrimRight(lines[i], "\r")
		if line != "" && !strings.HasPrefix(line, " ") {
			end = i
			break
		}
	}

	var block, annotations []string
	uidSet := false
	inAnnotations := false
	entryIndent := -1
	skipping := false
	for _, raw := range lines[start+1 : end] {
		line := strings.TrimSuffix(raw, "\r")
		if line == "" {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		if inAnnotations && indent > 2 {
			if entryIndent < 0 {
				entryIndent = indent
			}
			// An entry (or a line no deeper than one): it starts or ends a skip.
			if indent <= entryIndent {
				match := annotationKey.FindStringSubmatch(line)
				skipping = match != nil && match[1] == CopiedFromAnnotation
			}
			if !skipping {
				annotations = append(annotations, line)
			}
			continue
		}
		inAnnotations = false
		key := ""
		if match := metadataKey.FindStringSubmatch(line); match != nil {
			key = match[1]
		}
		if key == "annotations" {
			inAnnotations = true
			continue
		}
		if key == "uid" {
			block = append(block, "  uid: "+newUID)
			uidSet = true
			continue
		}
		block = append(block, line)
	}
	if !uidSet {
		block = append(block, "  uid: "+newUID)
	}
	if entryIndent < 0 {
		entryIndent = 4
	}
	block = append(block, "  annotations:")
	block = append(block, annotations...)
	block = append(block, strings.Repeat(" ", entryIndent)+CopiedFromAnnotation+": "+sourceUID)

	result := append([]string{}, lines[:start+1]...)
	for _, line := range block {
		result = append(result, line+eol)
	}
	result = append(result, lines[end:]...)
	return strings.Join(result, "\n"), nil
}
