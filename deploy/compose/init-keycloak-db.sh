#!/bin/bash
set -e
# Runs as a docker-entrypoint-initdb.d script on FIRST-TIME cluster initialization only (like the
# sibling init scripts). Keycloak (staging identity provider, round table 2026-09-13) gets its own
# database and its own login role inside the same Postgres instance, so the application's
# app_user grants (init-db.sql) and Keycloak's schema never touch. KEYCLOAK_DB_PASSWORD comes from
# the postgres service environment (docker-compose.yml); it is the same value the keycloak
# service presents as KC_DB_PASSWORD.
: "${KEYCLOAK_DB_PASSWORD:?set KEYCLOAK_DB_PASSWORD (postgres service environment) before first boot}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
  CREATE ROLE keycloak LOGIN PASSWORD '${KEYCLOAK_DB_PASSWORD}';
  CREATE DATABASE keycloak OWNER keycloak;
EOSQL
