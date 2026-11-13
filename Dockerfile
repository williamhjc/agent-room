FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY server ./server
COPY public ./public
COPY agent ./agent
ENV PORT=8787 DATA_DIR=/app/data
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["node", "server/index.js"]
