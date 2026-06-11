#!/usr/bin/env bash
# Download the optional neural airplane-detector model for the camera tracker.
#
# The model is NOT committed to the repo (keeps it small + license-clean). The
# tracker runs fine without it — the neural layer self-disables and the
# classical detectors carry on. Run this on the machine that owns the camera
# (the Pi) to enable the semantic "is it an airplane?" signal.
#
# Default: YOLOX-Nano, COCO-pretrained, Apache-2.0, ~3.5 MB, 416×416 input,
# standard YOLOX grid/stride output that tracker/src/vision/net.ts decodes.
#
# Override the source or destination via env:
#   MODEL_URL   full download URL of a .onnx model
#   MODEL_DEST  output path (default tracker/models/yolox_nano.onnx)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_DEST="${MODEL_DEST:-$REPO/tracker/models/yolox_nano.onnx}"
# YOLOX-Nano ONNX (Megvii, Apache-2.0). Mirror it yourself and set MODEL_URL
# if this asset ever moves.
MODEL_URL="${MODEL_URL:-https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx}"

mkdir -p "$(dirname "$MODEL_DEST")"

if [ -f "$MODEL_DEST" ]; then
  echo "==> model already present: $MODEL_DEST"
  echo "    (delete it to re-download, or set MODEL_DEST elsewhere)"
  exit 0
fi

echo "==> downloading vision model"
echo "    from: $MODEL_URL"
echo "    to:   $MODEL_DEST"
if command -v curl >/dev/null; then
  curl -fL --retry 3 -o "$MODEL_DEST.part" "$MODEL_URL"
elif command -v wget >/dev/null; then
  wget -O "$MODEL_DEST.part" "$MODEL_URL"
else
  echo "need curl or wget" >&2; exit 1
fi
mv "$MODEL_DEST.part" "$MODEL_DEST"

# Sanity: ONNX files start with the protobuf magic; a 404 HTML page does not.
SIZE=$(wc -c < "$MODEL_DEST")
if [ "$SIZE" -lt 100000 ]; then
  echo "!! downloaded file is only $SIZE bytes — likely an error page, not a model." >&2
  echo "   inspect $MODEL_DEST or set MODEL_URL to a working mirror." >&2
  exit 1
fi
echo "==> done ($SIZE bytes). Restart skylight-tracker to load it:"
echo "    sudo systemctl restart skylight-tracker"
echo "    Verify in the tracker state: vision.net.ready == true"
