FROM node:22-alpine

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install dependencies
RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm install

# Copy application source
COPY . .

EXPOSE 8080

CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "8080"]
