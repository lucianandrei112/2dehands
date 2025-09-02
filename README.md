### Run local
npm i
npm run install-playwright
npm run dev

GET http://localhost:3000/latest
GET http://localhost:3000/latest?url=<ENCODED_LIST_URL>

### Deploy to Railway
- New Project -> Deploy from Repo
- No special variables needed
- Service will expose /healthz and /latest
