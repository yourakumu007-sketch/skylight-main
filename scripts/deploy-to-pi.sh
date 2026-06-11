#!/usr/bin/env bash
# Push the current working tree to the Skylight Pi, rebuild, restart the server,
# and reload the kiosk. Configure via env:
#   PI_HOST     (default skylight.local)
#   PI_USER     (default pi)
#   PI_APPDIR   (default /home/<PI_USER>/skylight)
#   SSH_KEY     (default ~/.ssh/id_ed25519 — a passphrase-less deploy key is ideal)
#   SERVICE     (default skylight-server)
#
# Example:
#   PI_HOST=skylight.local ./scripts/deploy-to-pi.sh
set -euo pipefail

PI_HOST="${PI_HOST:-skylight.local}"
PI_USER="${PI_USER:-pi}"
PI_APPDIR="${PI_APPDIR:-/home/$PI_USER/skylight}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SERVICE="${SERVICE:-skylight-server}"
SSH="ssh -i $SSH_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

REPO="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> rsync $REPO/ -> $PI_USER@$PI_HOST:$PI_APPDIR/"
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude .git \
  --exclude 'server/data' --exclude data \
  -e "$SSH" "$REPO/" "$PI_USER@$PI_HOST:$PI_APPDIR/"

echo "==> install + build + restart on the Pi"
# shellcheck disable=SC2087
$SSH "$PI_USER@$PI_HOST" "
  set -e
  cd '$PI_APPDIR'
  export CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  # The tracker's video pipeline shells out to ffmpeg.
  command -v ffmpeg >/dev/null || sudo apt-get install -y ffmpeg
  pnpm install
  pnpm build
  # Install/refresh the camera-tracker service (idempotent).
  PNPM_BIN=\$(command -v pnpm)
  sudo sed \
    -e \"s#__USER__#\$(id -un)#g\" \
    -e \"s#__APPDIR__#$PI_APPDIR#g\" \
    -e \"s#__PNPM__#\$PNPM_BIN#g\" \
    '$PI_APPDIR/pi-setup/skylight-tracker.service' \
    | sudo tee /etc/systemd/system/skylight-tracker.service >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable skylight-tracker.service >/dev/null 2>&1 || true
  sudo systemctl restart $SERVICE
  sudo systemctl restart skylight-tracker.service
"

echo "==> reload kiosk (projector on HDMI-A-1 + TV dashboard on HDMI-A-2)"
$SSH "$PI_USER@$PI_HOST" '
  # TV kiosk launcher: second Chromium instance placed on the second output.
  # Under Xwayland the outputs form one extended X screen, so the window is
  # positioned at x=1920 and fullscreened there.
  mkdir -p "$HOME/.local/bin"
  CHROMIUM=$(command -v chromium-browser || command -v chromium)
  cat > "$HOME/.local/bin/skylight-tv-kiosk.sh" <<EOF
#!/usr/bin/env bash
export DISPLAY=:0
export XDG_RUNTIME_DIR=/run/user/\$(id -u)
until curl -fsS http://localhost:3001/api/tracker/health >/dev/null 2>&1; do sleep 1; done
exec $CHROMIUM \
  --ozone-platform=x11 --app=http://localhost:3000/tv.html \
  --user-data-dir=\$HOME/.tv-kiosk-profile --no-first-run --password-store=basic \
  --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --check-for-update-interval=31536000 \
  --window-position=1920,0 --start-fullscreen
EOF
  chmod +x "$HOME/.local/bin/skylight-tv-kiosk.sh"
  # Autostart it alongside the projector kiosk (wayfire).
  INI="$HOME/.config/wayfire.ini"
  if [ -f "$INI" ] && ! grep -q skylight-tv-kiosk "$INI"; then
    sed -i "/\[autostart\]/a skylight_tv = $HOME/.local/bin/skylight-tv-kiosk.sh" "$INI"
  fi
  export XDG_RUNTIME_DIR=/run/user/$(id -u) WAYLAND_DISPLAY=wayland-1
  pkill -f "/usr/lib/chrom[i]um" 2>/dev/null || true
  sleep 2
  setsid "$HOME/.local/bin/skylight-kiosk.sh" < /dev/null > "$HOME/kiosk.log" 2>&1 &
  sleep 1
  setsid "$HOME/.local/bin/skylight-tv-kiosk.sh" < /dev/null > "$HOME/tv-kiosk.log" 2>&1 &
  sleep 1
' || true

echo "Done → display http://$PI_HOST:3000/ · control /control · TV /tv.html · tracker UI /tracker.html"
