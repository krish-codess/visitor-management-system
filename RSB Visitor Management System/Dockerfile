FROM node:18-alpine

WORKDIR /usr/src/app

# Install system dependencies first
RUN apk add --no-cache sqlite python3 make g++

# Install npm packages with exact versions
COPY package*.json ./
RUN npm install --production --legacy-peer-deps --frozen-lockfile
RUN npm install exceljs@4.4.0 --save-exact

# Verify installation
RUN npm list exceljs && ls -la node_modules/exceljs

COPY . .

CMD ["node", "server.js"]