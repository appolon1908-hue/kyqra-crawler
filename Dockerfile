FROM mcr.microsoft.com/playwright:v1.55.0-noble
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install --omit=optional && npm cache clean --force
COPY src ./src
RUN npm run build
RUN mkdir -p /app/storage && chown -R pwuser:pwuser /app/storage
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
USER pwuser
CMD ["npm","start"]
