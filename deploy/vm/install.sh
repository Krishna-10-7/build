#!/bin/sh
# Installs a release on the VM. Run as root: sh install.sh /tmp/sentinelqa.tar.gz
# Secrets live in /etc/sentinelqa/sentinelqa.env (see sentinelqa.env.example), never in the release.
set -eu
TAR="$1"
APP=/opt/sentinelqa
DATA=/var/lib/sentinelqa

id sentinelqa >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin sentinelqa
mkdir -p "$APP/releases" "$DATA" /etc/sentinelqa
REL="$APP/releases/$(date +%Y%m%d%H%M%S)"
mkdir -p "$REL"
tar -xzf "$TAR" -C "$REL"

cd "$REL"
npm ci --no-audit --no-fund
npm run build
PLAYWRIGHT_BROWSERS_PATH="$DATA/ms-playwright" npx playwright install --with-deps chromium
sh deploy/vm/sandbox-setup.sh

chown -R sentinelqa: "$REL" "$DATA"
ln -sfn "$REL" "$APP/current"

cp deploy/vm/sentinelqa-shoplite.service deploy/vm/sentinelqa.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable sentinelqa-shoplite sentinelqa >/dev/null
systemctl restart sentinelqa-shoplite sentinelqa

# Keep the last three releases.
ls -1dt "$APP"/releases/* | tail -n +4 | xargs -r rm -rf
echo "installed $REL"
