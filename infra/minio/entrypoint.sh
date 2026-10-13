#!/bin/sh
set -eu
if [ "${MINIO_ROOT_USER:-}" = MINIO_NOT_CONFIGURED ] || [ "${MINIO_ROOT_PASSWORD:-}" = MINIO_NOT_CONFIGURED ] || [ -z "${MINIO_ROOT_USER:-}" ] || [ -z "${MINIO_ROOT_PASSWORD:-}" ]; then
  echo 'MinIO credentials are missing. Configure the private environment before enabling MinIO.' >&2
  exit 1
fi
exec minio "$@"
