# ================================
# Node.js Backend - Dockerfile
# ================================

FROM node:18-alpine

# Install build tools needed for bcrypt (native module)
RUN apk add --no-cache python3 make g++

# Set working directory
WORKDIR /app

# Copy package files first (for layer caching)
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy the rest of the source code
COPY . .

# Create uploads folder (used by multer)
RUN mkdir -p uploads

# Expose port
EXPOSE 5000

# Start the server
CMD ["node", "app.js"]
