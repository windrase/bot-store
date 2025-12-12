#Bot Store Telegram

#Install
```
bash <(curl -s https://raw.githubusercontent.com/windrase/bot-store/main/install.sh)
```
#StringQris

https://scanqr.org/

#Ubah Token Dan Username di apipaymentcekorkut
```bash
const qs = require('qs');

function buildPayload() {
  return qs.stringify({
    'username': 'allufi',
    'token': '1991647:0jkip97VR6huEtrc2XvWUDsOBY5yFMxA',
    'jenis': 'masuk'
  });
}

const headers = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'Accept-Encoding': 'gzip',
  'User-Agent': 'okhttp/4.12.0'
};

const API_URL = 'https://orkutapi.andyyuda41.workers.dev/api/qris-history';

module.exports = { buildPayload, headers, API_URL };
```
