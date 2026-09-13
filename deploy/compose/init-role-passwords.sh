#!/bin/bash
set -e
# Runs as a docker-entrypoint-initdb.d script on FIRST-TIME cluster initialization only, right
# after 01-init-db.sql (alphabetical order). init-db.sql creates the four runtime roles with
# placeholder passwords so it stays a plain SQL file the test harness can apply verbatim; this
# script immediately replaces every placeholder with the value the compose stack was given
# (deferred-work 94, finished 2026-09-13 on the staging VPS: the compose half of that row dropped
# the fallbacks, the SQL half was still shipping 'app_password' to a public box). All four are
# required; a missing one fails the first boot loudly instead of leaving a known password behind.
: "${DB_PASSWORD:?set DB_PASSWORD (app_user) in the postgres service environment}"
: "${READONLY_PASSWORD:?set READONLY_PASSWORD (readonly_user) in the postgres service environment}"
: "${REPLICATION_PASSWORD:?set REPLICATION_PASSWORD (replication_user) in the postgres service environment}"
: "${POWERSYNC_SOURCE_PASSWORD:?set POWERSYNC_SOURCE_PASSWORD (svc_powersync) in the postgres service environment}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app="$DB_PASSWORD" -v ro="$READONLY_PASSWORD" -v repl="$REPLICATION_PASSWORD" -v ps="$POWERSYNC_SOURCE_PASSWORD" <<-'EOSQL'
  ALTER USER app_user WITH PASSWORD :'app';
  ALTER USER readonly_user WITH PASSWORD :'ro';
  ALTER USER replication_user WITH PASSWORD :'repl';
  ALTER USER svc_powersync WITH PASSWORD :'ps';
EOSQL
echo "init-role-passwords: the four runtime role passwords were set from the environment"
