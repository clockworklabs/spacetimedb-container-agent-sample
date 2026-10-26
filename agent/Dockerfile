# `spacetime publish` builds this image for the server's platform (spacetime.json's
# `container.build` points here). The build stage runs on your machine's own platform,
# since the bundle is plain JavaScript; only the runtime stage is per platform, so no
# emulation is needed. BuildKit sets BUILDPLATFORM.
ARG BUILDPLATFORM
# Node 22.23.4 includes the October security fixes and updated CA roots.
FROM --platform=$BUILDPLATFORM node:22.23.4-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Node 22.23.4 includes the October security fixes and updated CA roots.
FROM node:22.23.4-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist/main.js ./main.js
# Do not add VOLUME instructions: the platform rejects images that declare them.
USER node
CMD ["node", "main.js"]
