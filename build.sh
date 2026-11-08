#!/bin/sh
# Builds the Rust game engine and copies snake_core.wasm next to index.html.
# Usage (from the repo folder):  sh build.sh
set -e
cd "$(dirname "$0")/rust"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/snake_core.wasm ../snake_core.wasm
echo "Done: snake_core.wasm updated"
