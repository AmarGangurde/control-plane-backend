#!/bin/bash
set -e

# Get the directory of the script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"

echo "🚀 Starting development database..."
# Use sudo to avoid permission issues, and specify the full path to the compose file
sudo docker compose -f "$BACKEND_DIR/docker-compose.dev.yml" up -d postgres

echo "⏳ Waiting for database to be ready..."
until sudo docker exec wrexer-postgres-dev pg_isready -U wrexer; do
  sleep 1
done

echo "✅ Database is ready!"
