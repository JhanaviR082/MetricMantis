FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
RUN npm install --omit=dev
USER node
CMD ["node", "server.js"]
