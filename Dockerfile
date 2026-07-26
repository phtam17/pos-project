FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/register/package.json apps/register/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/payment-contract/package.json packages/payment-contract/package.json
COPY packages/payments-simulated/package.json packages/payments-simulated/package.json
COPY packages/persistence/package.json packages/persistence/package.json

RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    STATIC_DIR=/app/apps/register/dist

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/register/package.json apps/register/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/payment-contract/package.json packages/payment-contract/package.json
COPY packages/payments-simulated/package.json packages/payments-simulated/package.json
COPY packages/persistence/package.json packages/persistence/package.json

RUN npm ci --omit=dev

COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/register/dist ./apps/register/dist
COPY --from=build /app/packages ./packages
COPY --from=build /app/scripts ./scripts

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["npm", "start"]
