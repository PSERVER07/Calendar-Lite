FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install

RUN apk add --no-cache fontconfig ttf-dejavu
RUN mkdir -p /usr/share/fonts/custom
COPY SF-Pro-Display-Bold.otf /usr/share/fonts/custom/
RUN fc-cache -f -v

COPY . .
EXPOSE 7000
CMD ["npm", "start"]
