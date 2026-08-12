// Package httpjson is how a handler answers: one way to write a JSON body,
// one shape for an error. A LEAF in the module graph — it imports nothing of
// this repo and knows nothing of stores or modules — so every module may use
// it without gaining an edge to any other.
//
// It exists because three modules had grown their own identical copies
// (world, artifacts, bake — found in the 2026-08-12 audit), and the error
// SHAPE `{"error": message}` is client-visible surface: a fourth copy would
// eventually drift, and the client parses this shape in errorMessage().
package httpjson

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// Write sends value as the JSON response body.
func Write(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

// ClientError answers a request the caller can fix, naming what to fix.
func ClientError(w http.ResponseWriter, status int, message string) {
	Write(w, status, map[string]string{"error": message})
}

// ServerError logs the detail and returns a generic message: the cause
// belongs in the operator's log, not in a response body.
func ServerError(w http.ResponseWriter, context string, err error) {
	slog.Error(context, "err", err)
	Write(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}
