FROM node:24.12.0-bookworm-slim
WORKDIR /opt/hydro
RUN npm install hydrooj@5.0.7 @hydrooj/register@1.0.4 @hydrooj/ui-default@4.58.5
COPY plugins/hydro-contest-center /opt/hydro/node_modules/hydro-contest-center
COPY infra/fixtures/hydro/bootstrap.ts /opt/hydro/node_modules/contest-center-fixture/index.ts
COPY infra/fixtures/hydro/package.json /opt/hydro/node_modules/contest-center-fixture/package.json
COPY infra/fixtures/hydro/start.sh /opt/start.sh
ENV NODE_APP_INSTANCE=0
CMD ["sh","/opt/start.sh"]
