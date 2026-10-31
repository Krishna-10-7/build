#!/bin/sh
# Rootless Podman for the sentinelqa user, and the egress fence. Run as root from install.sh.
set -eu
DATA=/var/lib/sentinelqa
IMAGE="${SANDBOX_IMAGE:-docker.io/library/node:22-bookworm-slim}"

command -v podman >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q podman slirp4netns uidmap nftables >/dev/null
grep -q '^sentinelqa:' /etc/subuid || usermod --add-subuids 300000-365535 --add-subgids 300000-365535 sentinelqa
# A user manager for sentinelqa, so containers get their own cgroups (memory, CPU and process limits).
loginctl enable-linger sentinelqa
uid=$(id -u sentinelqa)
for i in $(seq 1 40); do [ -S "/run/user/$uid/bus" ] && break; sleep 0.5; done

mkdir -p "$DATA/.config/containers"
cat > "$DATA/.config/containers/containers.conf" <<CONF
[engine]
events_logger = "file"
[containers]
log_driver = "k8s-file"
CONF
chown -R sentinelqa: "$DATA/.config"

as_sqa() { runuser -u sentinelqa -- env HOME="$DATA" XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@"; }
as_sqa podman image exists "$IMAGE" || as_sqa podman pull -q "$IMAGE" >/dev/null

install -m 644 deploy/vm/egress.nft /etc/sentinelqa/egress.nft
cp deploy/vm/sentinelqa-egress.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable sentinelqa-egress >/dev/null
systemctl restart sentinelqa-egress
echo "sandbox ready: podman $(podman --version | awk '{print $3}'), image $IMAGE"
