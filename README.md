# Wrexer Control Plane Backend

This is the backend service for the Wrexer Platform-as-a-Service (PaaS). It provides a REST API to manage Kubernetes resources, user authentication, API keys, and billing.

## 🚀 Features

- **Kubernetes Management**: Direct interaction with K8s clusters to manage application deployments.
- **Authentication**: secure authentication flow (Google Sign-In integration).
- **API Key Management**: Generate and manage API keys for programmatic access.
- **Billing System**: Integrated billing routes for managing usage and payments.
- **Rate Limiting**: Built-in rate limiting for API protection.
- **Security**: CORS configuration, Admin-only routes, and secure headers.

## 🛠️ Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: SQLite (via `better-sqlite3`)
- **Kubernetes**: `@kubernetes/client-node`
- **Other**: Check `package.json` for full list of dependencies.

## 📋 Prerequisites

- Node.js (v18+ recommended)
- npm or yarn
- Docker (optional, for containerized deployment)
- Access to a Kubernetes cluster (kubeconfig context) if running locally with full features.

## 🔧 Installation & Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd control-plane-backend
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Environment Configuration**
   Create a `.env` file in the root directory. You can use `.env.example` as a reference if available. Key variables likely include:
   - `PORT`: Server port (default: 3000)
   - `FRONTEND_URL`: URL of the frontend application (for CORS)
   - `KUBECONFIG`: Path to kubeconfig (if not using default)
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: For auth
   - `ADMIN_KEY`: For admin routes

4. **Run Locally**
   
   **Development Mode** (with hot-reload via nodemon):
   ```bash
   npm run dev
   ```

   **Production Mode**:
   ```bash
   npm start
   ```

## 🐳 Docker Deployment

To build and run the application using Docker:

```bash
# Build the image
docker build -t wrexer-backend .

# Run the container
docker run -p 3000:3000 --env-file .env wrexer-backend
```

Or usage `docker-compose`:

```bash
docker-compose up -d
```

## 📡 API Endpoints Overview

- **Health Check**: `GET /health`
- **Auth**: `/api/auth/*` - Authentication routes
- **Apps**: `/api/apps/*` - Application management (Requires API Key)
- **Keys**: `/api/keys/*` - API Key management (Admin only)
- **Billing**: `/api/billing/*` - Billing operations

## 📁 Project Structure

```
src/
├── config/         # Configuration files
├── controllers/    # Request handlers
├── db/            # Database connection & schemas
├── middleware/     # Auth, Rate limiting, etc.
├── models/         # Data models
├── routes/         # API route definitions
├── services/       # Business logic (K8s, Billing, etc.)
└── utils/          # Helper functions
```