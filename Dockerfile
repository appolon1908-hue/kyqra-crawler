FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci && npm cache clean --force
COPY scripts/copy-static.mjs ./scripts/copy-static.mjs
COPY src ./src
RUN npm run build && npm prune --omit=dev --omit=optional

FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e
WORKDIR /app
USER root
RUN apt-get purge -y --auto-remove gstreamer1.0-plugins-bad libgstreamer-plugins-bad1.0-0 \
    && rm -rf /var/lib/apt/lists/* /usr/lib/node_modules/npm /usr/lib/node_modules/yarn \
      /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/yarn \
      /usr/bin/npm /usr/bin/npx /usr/bin/yarn /usr/bin/yarnpkg
COPY --from=build --chown=pwuser:pwuser /app/package.json /app/package-lock.json ./
COPY --from=build --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=build --chown=pwuser:pwuser /app/dist ./dist
RUN mkdir -p /app/storage && chown -R pwuser:pwuser /app/storage
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
USER pwuser
CMD ["node", "dist/main.js"]
