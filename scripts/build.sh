#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" == Darwin ]]; then
  cargo build --locked --release --lib --bin chrominimum --bin chrominimum_helper --bin bundle
else
  cargo build --locked --release --lib --bin chrominimum --bin bundle
fi
target/release/bundle
