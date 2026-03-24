FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY backend/package.json ./backend/package.json
RUN npm install --prefix backend

COPY backend ./backend
RUN npm run build --prefix backend && npm prune --prefix backend --omit=dev

FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV SQLITE_DB_PATH=/data/b24-calendar.sqlite
ENV SYNC_ENABLED=false

COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY frontend ./frontend

# Rebuild native modules (better-sqlite3) for production image
RUN npm rebuild --prefix backend

VOLUME ["/data"]
EXPOSE 3000

CMD ["npm", "start", "--prefix", "backend"]
