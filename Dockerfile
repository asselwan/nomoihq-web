FROM node:22-alpine

WORKDIR /app

COPY . .

ENV PORT=80
ENV REPORTS_DIR=/app/reports
ENV ORDERS_DIR=/data/orders

EXPOSE 80

CMD ["node", "server.mjs"]
