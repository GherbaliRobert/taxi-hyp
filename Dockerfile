FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# Baza de date (data/taxi.db) trebuie să fie pe un volum, ca să nu se piardă la actualizarea containerului.
RUN chown -R node:node /app/data
VOLUME /app/data
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server.js"]
