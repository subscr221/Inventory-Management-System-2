#!/bin/bash
# Staging front door on the Webuzo VPS (round table 2026-09-13). Ports 80 and 443 belong to the
# panel's own nginx, so the stack's nginx runs under the "standalone" profile on 8443 and
# Cloudflare's proxy reaches it through an Origin Rule; certificates come from certbot in
# standalone mode on the free port 80 (the two records must be DNS-only while this runs).
# Idempotent: re-running keeps an unexpired certificate and restarts nothing that is healthy.
# Usage (as root on the box): /opt/ims/deploy/provision/staging-front-door.sh
set -euo pipefail
COMPOSE_DIR=/opt/ims/deploy/compose
NAMES=(ims-staging.ancorlabs.org auth.ancorlabs.org)
LIVE=/etc/letsencrypt/live/${NAMES[0]}

cd "$COMPOSE_DIR"
sed -i 's/\r$//' docker-compose.yml nginx.conf.template
mkdir -p certs

echo "=== certbot (standalone, port 80)"
certbot certonly --standalone -d "${NAMES[0]}" -d "${NAMES[1]}" --non-interactive --agree-tos \
  --keep-until-expiring 2>&1 | grep -E "Successfully|Certificate is saved|Key is saved|Failed|failed|Problem|Detail|expires|not yet due" | head -6 || true
if [ ! -f "$LIVE/fullchain.pem" ]; then
  echo "NO CERTIFICATE at $LIVE - stopping before touching the stack"
  exit 4
fi

echo "=== renewal hook"
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/ims-nginx-reload.sh <<'EOF'
#!/bin/bash
# Reload the IMS nginx container after a Let's Encrypt renewal (staging VPS, 2026-09-13).
cd /opt/ims/deploy/compose && docker compose --profile standalone exec -T nginx nginx -s reload
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/ims-nginx-reload.sh
echo "hook installed"

echo "=== .env additions"
if ! grep -q '^NGINX_HTTPS_HOST_PORT=' .env; then
  cat >> .env <<EOF
NGINX_HTTP_HOST_PORT=8081
NGINX_HTTPS_HOST_PORT=8443
TLS_CERT_PATH=$LIVE/fullchain.pem
TLS_KEY_PATH=$LIVE/privkey.pem
EOF
  echo "added"
else
  echo "already present"
fi

echo "=== nginx container (standalone profile)"
docker compose --profile standalone up -d nginx 2>&1 | grep -E "Started|Running|Error|failed" | tail -3 || true
sleep 5
docker compose --profile standalone ps --format '{{.Name}} {{.Status}}' | grep nginx || true

echo "=== verify on 8443 from the box"
curl -s -m 10 --resolve "${NAMES[0]}:8443:127.0.0.1" "https://${NAMES[0]}:8443/api/v1/health"; echo
curl -s -m 10 -o /dev/null -w "auth discovery via 8443: http %{http_code}\n" \
  --resolve "${NAMES[1]}:8443:127.0.0.1" "https://${NAMES[1]}:8443/realms/ims/.well-known/openid-configuration"
echo "=== certificate presented"
openssl s_client -connect 127.0.0.1:8443 -servername "${NAMES[1]}" </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -enddate 2>/dev/null || true
