#!/bin/bash
set -e
# Runs as a docker-entrypoint-initdb.d script on first-time cluster initialization only.
# archive_command (see docker-compose.yml) needs this directory to exist before the
# first checkpoint/archive attempt.
mkdir -p /var/lib/postgresql/wal_archive
