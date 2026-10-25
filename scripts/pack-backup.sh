#!/usr/bin/env bash
set -euo pipefail
stage="${1:?backup staging directory is required}"
# BSD tar can still emit provenance xattrs with COPYFILE_DISABLE; GNU tar accepts the same flag.
# Keep PAX size support for large backups and the restore validator's strict metadata allowlist.
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$stage/raw.tgz" -C "$stage" database.dump files.tgz environment.env
