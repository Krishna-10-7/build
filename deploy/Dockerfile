# Playwright's image ships the browsers that match the pinned playwright version.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app
ENV NODE_ENV=production CI=1

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/engine/package.json packages/engine/
COPY apps/shoplite/package.json apps/shoplite/
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --include=dev

COPY . .
RUN npm run build

EXPOSE 4100 4200
CMD ["npm", "run", "server"]
