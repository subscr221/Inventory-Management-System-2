#!/bin/bash
set -e
# Runs as a docker-entrypoint-initdb.d script on first-time cluster initialization only.
# The official postgres image's generated pg_hba.conf covers ordinary databases ("all") but
# never the special "replication" pseudo-database, so postgres-standby's pg_basebackup
# connection (see docker-compose.yml) needs an explicit rule or it is rejected outright.
echo "host replication replication_user all scram-sha-256" >> "$PGDATA/pg_hba.conf"
