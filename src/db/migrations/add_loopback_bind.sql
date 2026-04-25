-- Migration: add loopback_bind column to apps table
-- This flag is set when a tenant image binds its server to 127.0.0.1 (loopback).
-- When true, the backend injects an nginx sidecar proxy into the pod so Kubernetes
-- can route traffic from the ClusterIP Service to the container.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS loopback_bind BOOLEAN NOT NULL DEFAULT FALSE;
