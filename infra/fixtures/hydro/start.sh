#!/bin/sh
set -eu
mkdir -p /root/.hydro
printf '%s' '{"url":"mongodb://mongo:27017/hydro"}' > /root/.hydro/config.json
printf '%s' '["@hydrooj/ui-default","/opt/hydro/node_modules/hydro-contest-center","/opt/hydro/node_modules/contest-center-fixture"]' > /root/.hydro/addon.json
exec /opt/hydro/node_modules/.bin/hydrooj --host 0.0.0.0 --port 8888
