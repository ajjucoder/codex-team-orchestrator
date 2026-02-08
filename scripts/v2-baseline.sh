#!/usr/bin/env bash
set -euo pipefail

node --import tsx scripts/v2-baseline.ts "$@"
