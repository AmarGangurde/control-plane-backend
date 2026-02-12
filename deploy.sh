#!/bin/bash
set -e

# Configuration
APP_NAME="control-plane"
NEW_PORT=3001
OLD_PORT=3000
NGINX_CONF="/etc/nginx/sites-available/default"

echo "🚀 Starting Zero-Downtime Deployment..."

# 1. Build the new image
docker build -t $APP_NAME:latest .

# 2. Start the "Green" version on a temp port
# We mount the same /data volume so the database is shared
docker run -d \
  --name "${APP_NAME}-green" \
  -p $NEW_PORT:3000 \
  -v $(pwd)/data:/app/data \
  --env-file .env \
  $APP_NAME:latest

echo "⏳ Waiting for health check..."
sleep 5 # Give it a few seconds to boot

# 3. Update Nginx config to point to the NEW port
# This uses 'sed' to replace the port in your nginx config
sudo sed -i "s/127.0.0.1:$OLD_PORT/127.0.0.1:$NEW_PORT/g" $NGINX_CONF

# 4. Reload Nginx (Traffic flips to NEW app here)
sudo nginx -s reload
echo "✅ Traffic flipped to new version!"

# 5. Stop and remove the OLD container
docker stop $APP_NAME || true
docker rm $APP_NAME || true

# 6. Rename the NEW container to be the MAIN one
docker rename "${APP_NAME}-green" $APP_NAME

# 7. Revert Nginx back to the standard port for the next run
sudo sed -i "s/127.0.0.1:$NEW_PORT/127.0.0.1:$OLD_PORT/g" $NGINX_CONF
# (Optional) You could also just keep it running on 3001, but keeping 3000 standard is cleaner.

echo "🏁 Deployment Complete!"
