#!/bin/bash

# EventFlow - Quick Start Script
# Run this first to setup everything

echo "🚀 EventFlow Platform - Quick Setup"
echo "=================================="
echo ""

# Check prerequisites
echo "Checking prerequisites..."
command -v node > /dev/null || { echo "❌ Node.js not installed (https://nodejs.org/)"; exit 1; }
command -v docker > /dev/null || { echo "❌ Docker not installed (https://www.docker.com/products/docker-desktop)"; exit 1; }
command -v docker-compose > /dev/null || { echo "❌ Docker Compose not installed"; exit 1; }
echo "✓ All prerequisites found"
echo ""

# Copy env file
if [ ! -f .env ]; then
    cp .env.example .env
    echo "✓ Created .env"
fi

# Start Docker services
echo "Starting Docker services (PostgreSQL, Redis, Elasticsearch)..."
docker-compose up -d
echo "✓ Docker services started"
sleep 15

# Install & setup backend
echo "Setting up backend..."
cd backend
npm install --silent 2>/dev/null
npm run migrate:latest > /dev/null 2>&1
echo "✓ Backend ready"
cd ..

# Install frontend
echo "Setting up frontend..."
cd frontend
npm install --silent 2>/dev/null
echo "✓ Frontend ready"
cd ..

# Install admin
echo "Setting up admin..."
cd admin
npm install --silent 2>/dev/null
echo "✓ Admin ready"
cd ..

echo ""
echo "✅ Setup complete!"
echo ""
echo "Now open 4 terminals and run these commands:"
echo ""
echo "Terminal 1:  cd backend && npm run dev"
echo "Terminal 2:  cd backend && npm run jobs:start"
echo "Terminal 3:  cd frontend && npm run dev"
echo "Terminal 4:  cd admin && npm run dev"
echo ""
echo "Then open:"
echo "  🌟 http://localhost:5173     (Event Search)"
echo "  📊 http://localhost:3001     (Admin)"
echo "  💾 http://localhost:8080     (Database)"
echo ""
