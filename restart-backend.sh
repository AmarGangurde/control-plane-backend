#!/bin/bash
# Find nodemon process for backend
PID=$(ps aux | grep "nodemon src/server.js" | grep -v grep | awk '{print $2}')
if [ -n "$PID" ]; then
    echo "Restarting backend (PID $PID)..."
    kill -HUP $PID
    echo "Sent SIGHUP to nodemon."
else
    echo "Backend nodemon not found. If it's running via npm run dev, it should auto-reload if we touch .env"
    touch src/server.js
fi
