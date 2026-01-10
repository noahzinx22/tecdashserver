# TecDash Online API (Render)

## Rodar local
1. `cd server`
2. `npm i`
3. `npm start`
API: `http://localhost:3000`

## Deploy no Render
- Crie um **Web Service** a partir da pasta `server/`
- Build command: `npm install`
- Start command: `npm start`

### Persistência
Por padrão, salva em `server/data/players.json`.
Se você quiser manter isso entre deploys, use um **Persistent Disk** no Render e aponte:
- env: `DATA_DIR=/var/data` (ou o mount path do seu disk)

## Rotas
- `GET /healthz`
- `POST /register`
- `POST /sync`
- `GET /leaderboard?playerId=...`
- `GET /me?playerId=...&token=...` (retorna código + QR dataURL)
- `POST /recover` (recupera via código e gira token)
