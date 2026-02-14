#!/bin/bash
# Quick test script for GHOST-HANDS

set -e

echo "🔍 Testing GHOST-HANDS System"
echo "=============================="
echo ""

cd "$(dirname "$0")/packages/ghosthands"

echo "1️⃣  Verifying setup..."
bun src/scripts/verify-setup.ts
echo ""

echo "2️⃣  Building project..."
cd ../..
bun run build
echo "✅ Build successful"
echo ""

echo "3️⃣  Running E2E tests..."
cd packages/ghosthands
bun run test:e2e
echo ""

echo "✅ All tests passed!"
echo ""
echo "🚀 Ready to start:"
echo "   Terminal 1: cd packages/ghosthands && bun run api:dev"
echo "   Terminal 2: cd packages/ghosthands && bun run worker:dev"
