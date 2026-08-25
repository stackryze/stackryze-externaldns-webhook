FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV PORT=8888
EXPOSE 8888
USER node
CMD ["node", "src/server.js"]
