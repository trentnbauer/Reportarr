FROM node:22-alpine
WORKDIR /app
COPY app.mjs config.mjs ui.html ./
VOLUME /data
EXPOSE 8080
CMD ["node", "app.mjs"]
