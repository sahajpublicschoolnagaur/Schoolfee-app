# School Fee Manager

## Deploy on Railway (Free)

1. Go to railway.app and sign in with GitHub
2. Click "New Project" → "Deploy from GitHub repo"
3. Select this repository
4. Click "Add Plugin" → select "PostgreSQL" (free database)
5. Go to your web service → Variables tab → add:
   - DATABASE_URL  → copy from PostgreSQL plugin's Connect tab
   - JWT_SECRET    → type any random text e.g. myschool-secret-2025-xyz
   - NODE_ENV      → production
6. Click Deploy — live in ~3 minutes!
