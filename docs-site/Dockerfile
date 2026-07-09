# Docs site — in-cluster build (docs.lan). GitHub Pages builds separately
# with DOCS_BASE_URL=/home-lab/ via .github/workflows/docs.yml.
FROM node:24-slim AS build
WORKDIR /site
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY . .
ENV DOCS_BASE_URL=/
RUN npm run build

FROM nginx:1.31-alpine
COPY --from=build /site/build /usr/share/nginx/html
EXPOSE 80
